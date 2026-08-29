import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import type {
  MailboxMessage,
  MailboxMessageStatus,
  PeerSessionInfo,
  SendPeerMessageResult,
} from '@/modules/session-mailbox/session-mailbox.types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MCP_SERVER_NAME = 'cloudcli-session-mailbox';
const MCP_TOKEN_CONFIG_KEY = 'session_mailbox_mcp_token';

export const MAX_MESSAGE_CHARS = 8000;
export const MAX_MESSAGES_PER_WINDOW = 20;
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const MAX_WAIT_MS = 60_000;

/** Every message ever sent, keyed by id. Process-lifetime only — see module docs. */
const messagesById = new Map<string, MailboxMessage>();
/** Unread (queued) message ids per recipient session, oldest first. */
const inboxBySession = new Map<string, string[]>();
/** Outbound send timestamps (ms) per sender session, for the rolling rate limit. */
const sendTimestamps = new Map<string, number[]>();
/** Resolvers waiting on a reply to a given messageId (send_peer_message / reply_to_peer with waitMs). */
const replyWaiters = new Map<string, Array<(reply: MailboxMessage) => void>>();

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};
let runtimeInjectFns: Partial<Record<LLMProvider, (command: string, options: Record<string, unknown>) => Promise<boolean>>> = {};

/**
 * Wires the provider runtimes the mailbox uses to deliver messages.
 * Called once at server startup with the same spawn/inject maps the chat
 * websocket handler uses, so a peer message either starts a fresh turn on an
 * idle session or attaches to a live one exactly like a real chat.send.
 */
export function configureSessionMailboxRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
  injectFns: Partial<Record<LLMProvider, (command: string, options: Record<string, unknown>) => Promise<boolean>>> = {},
): void {
  runtimeSpawnFns = spawnFns;
  runtimeInjectFns = injectFns;
}

function titleFor(row: { custom_name: string | null; session_id: string }): string {
  return row.custom_name?.trim() || `Untitled (${row.session_id.slice(0, 8)})`;
}

function requireSession(sessionId: string): NonNullable<ReturnType<typeof sessionsDb.getSessionById>> {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.is_internal) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  return row;
}

function pruneAndCheckRateLimit(sessionId: string): void {
  const now = Date.now();
  const timestamps = (sendTimestamps.get(sessionId) ?? []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS,
  );
  if (timestamps.length >= MAX_MESSAGES_PER_WINDOW) {
    throw new AppError(
      `Rate limit exceeded: at most ${MAX_MESSAGES_PER_WINDOW} peer messages per ${RATE_LIMIT_WINDOW_MS / 60_000} minutes.`,
      { code: 'RATE_LIMITED', statusCode: 429 },
    );
  }
  timestamps.push(now);
  sendTimestamps.set(sessionId, timestamps);
}

function enqueue(message: MailboxMessage): void {
  const inbox = inboxBySession.get(message.toSessionId) ?? [];
  inbox.push(message.id);
  inboxBySession.set(message.toSessionId, inbox);
}

function resolveReplyWaiters(reply: MailboxMessage): void {
  if (!reply.inReplyTo) {
    return;
  }
  const waiters = replyWaiters.get(reply.inReplyTo);
  if (!waiters || waiters.length === 0) {
    return;
  }
  replyWaiters.delete(reply.inReplyTo);
  for (const resolve of waiters) {
    resolve(reply);
  }
}

function waitForReply(messageId: string, waitMs: number): Promise<MailboxMessage | null> {
  if (waitMs <= 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const waiters = replyWaiters.get(messageId);
      if (waiters) {
        const remaining = waiters.filter((w) => w !== onReply);
        if (remaining.length > 0) {
          replyWaiters.set(messageId, remaining);
        } else {
          replyWaiters.delete(messageId);
        }
      }
      resolve(null);
    }, waitMs);
    // Never keep the process alive just to time out a mailbox wait.
    timer.unref?.();

    function onReply(reply: MailboxMessage): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reply);
    }

    const waiters = replyWaiters.get(messageId) ?? [];
    waiters.push(onReply);
    replyWaiters.set(messageId, waiters);
  });
}

async function deliverOrQueue(input: {
  messageId: string;
  fromSessionId: string;
  fromTitle: string;
  fromProvider: LLMProvider;
  toSessionId: string;
  toRow: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  content: string;
  wrappedContent: string;
  inReplyTo: string | null;
}): Promise<MailboxMessage> {
  const { toRow } = input;
  const provider = toRow.provider as LLMProvider;
  const messageId = input.messageId;

  const spawnFn = runtimeSpawnFns[provider];
  let status: MailboxMessageStatus = 'queued';

  if (spawnFn) {
    try {
      const result = await startProviderRun({
        appSessionId: input.toSessionId,
        provider,
        providerSessionId: toRow.provider_session_id,
        projectPath: toRow.runtime_project_path ?? toRow.project_path,
        spawnFn,
        injectFn: runtimeInjectFns[provider],
        content: input.wrappedContent,
        options: {},
        connection: DETACHED_CONNECTION,
        userId: null,
      });
      if (result.ok) {
        status = 'delivered';
      }
    } catch (error) {
      // A delivery failure degrades to "queued" rather than losing the message.
      console.error('[SessionMailbox] delivery failed, queueing instead', {
        toSessionId: input.toSessionId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  const message: MailboxMessage = {
    id: messageId,
    fromSessionId: input.fromSessionId,
    fromTitle: input.fromTitle,
    fromProvider: input.fromProvider,
    toSessionId: input.toSessionId,
    toTitle: titleFor(toRow),
    content: input.content,
    createdAt: new Date().toISOString(),
    status,
    inReplyTo: input.inReplyTo,
  };

  messagesById.set(message.id, message);
  if (status === 'queued') {
    enqueue(message);
  }
  resolveReplyWaiters(message);

  return message;
}

function formatInjectedContent(fromTitle: string, fromProvider: string, messageId: string, content: string): string {
  return (
    `[Peer message from session "${fromTitle}" (${fromProvider})]\n${content}\n\n` +
    `Reply via reply_to_peer (messageId=${messageId}) or send_peer_message.`
  );
}

function getMcpToken(): string {
  const existing = appConfigDb.get(MCP_TOKEN_CONFIG_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(MCP_TOKEN_CONFIG_KEY, token);
  return token;
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/session-mailbox-mcp`;
}

function getMcpCommand(): { command: string; args: string[] } {
  const serverDir = path.resolve(__dirname, '..', '..');
  const mcpScriptPath = path.join(serverDir, 'session-mailbox-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return { command: process.execPath, args: [mcpScriptPath] };
  }
  return { command: 'cloudcli', args: ['session-mailbox-mcp'] };
}

export const sessionMailboxService = {
  configureRuntimes: configureSessionMailboxRuntimes,

  listPeerSessions(selfSessionId: string): PeerSessionInfo[] {
    const self = requireSession(selfSessionId);
    if (!self.project_path) {
      return [];
    }

    return sessionsDb
      .getSessionsByProjectPath(self.project_path)
      .filter((row) => row.session_id !== selfSessionId && !row.is_internal)
      .map((row) => ({
        sessionId: row.session_id,
        title: titleFor(row),
        provider: row.provider as LLMProvider,
        model: null,
        busy: chatRunRegistry.isProcessing(row.session_id),
        lastActivity: row.updated_at ?? row.created_at,
      }));
  },

  async sendPeerMessage(input: {
    fromSessionId: string;
    toSessionId: string;
    message: string;
    waitMs?: number;
  }): Promise<SendPeerMessageResult> {
    const content = input.message?.trim() ?? '';
    if (!content) {
      throw new AppError('message is required.', { code: 'MESSAGE_REQUIRED', statusCode: 400 });
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new AppError(`message exceeds the ${MAX_MESSAGE_CHARS} character limit.`, {
        code: 'MESSAGE_TOO_LONG',
        statusCode: 400,
      });
    }
    if (input.toSessionId === input.fromSessionId) {
      throw new AppError('Cannot send a peer message to your own session.', {
        code: 'INVALID_RECIPIENT',
        statusCode: 400,
      });
    }

    const fromRow = requireSession(input.fromSessionId);
    const toRow = requireSession(input.toSessionId);

    if (!fromRow.project_path || fromRow.project_path !== toRow.project_path) {
      throw new AppError('Peer messages can only be sent within the same project.', {
        code: 'CROSS_PROJECT_DENIED',
        statusCode: 403,
      });
    }

    pruneAndCheckRateLimit(input.fromSessionId);

    const fromTitle = titleFor(fromRow);
    const messageId = randomUUID();
    const wrappedContent = formatInjectedContent(fromTitle, fromRow.provider, messageId, content);

    const message = await deliverOrQueue({
      messageId,
      fromSessionId: input.fromSessionId,
      fromTitle,
      fromProvider: fromRow.provider as LLMProvider,
      toSessionId: input.toSessionId,
      toRow,
      content,
      wrappedContent,
      inReplyTo: null,
    });

    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, MAX_WAIT_MS));
    const reply = await waitForReply(message.id, waitMs);

    return {
      messageId: message.id,
      delivered: message.status === 'delivered',
      queued: message.status === 'queued',
      reply,
      timedOut: waitMs > 0 && reply === null,
    };
  },

  checkPeerInbox(sessionId: string): { messages: MailboxMessage[] } {
    requireSession(sessionId);
    const ids = inboxBySession.get(sessionId) ?? [];
    const messages: MailboxMessage[] = [];
    for (const id of ids) {
      const message = messagesById.get(id);
      if (!message) continue;
      message.status = 'read';
      messages.push({ ...message });
    }
    inboxBySession.set(sessionId, []);
    return { messages };
  },

  async replyToPeer(input: {
    fromSessionId: string;
    messageId: string;
    message: string;
    waitMs?: number;
  }): Promise<SendPeerMessageResult> {
    const original = messagesById.get(input.messageId);
    if (!original || original.toSessionId !== input.fromSessionId) {
      throw new AppError(`No peer message "${input.messageId}" was addressed to this session.`, {
        code: 'MESSAGE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const content = input.message?.trim() ?? '';
    if (!content) {
      throw new AppError('message is required.', { code: 'MESSAGE_REQUIRED', statusCode: 400 });
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new AppError(`message exceeds the ${MAX_MESSAGE_CHARS} character limit.`, {
        code: 'MESSAGE_TOO_LONG',
        statusCode: 400,
      });
    }

    const fromRow = requireSession(input.fromSessionId);
    const toRow = requireSession(original.fromSessionId);
    if (!fromRow.project_path || fromRow.project_path !== toRow.project_path) {
      throw new AppError('Peer messages can only be sent within the same project.', {
        code: 'CROSS_PROJECT_DENIED',
        statusCode: 403,
      });
    }

    pruneAndCheckRateLimit(input.fromSessionId);

    const fromTitle = titleFor(fromRow);
    const replyMessageId = randomUUID();
    const wrappedContent = formatInjectedContent(fromTitle, fromRow.provider, replyMessageId, content);

    const message = await deliverOrQueue({
      messageId: replyMessageId,
      fromSessionId: input.fromSessionId,
      fromTitle,
      fromProvider: fromRow.provider as LLMProvider,
      toSessionId: original.fromSessionId,
      toRow,
      content,
      wrappedContent,
      inReplyTo: input.messageId,
    });

    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, MAX_WAIT_MS));
    const reply = await waitForReply(message.id, waitMs);

    return {
      messageId: message.id,
      delivered: message.status === 'delivered',
      queued: message.status === 'queued',
      reply,
      timedOut: waitMs > 0 && reply === null,
    };
  },

  // -- MCP catalog registration -------------------------------------------------

  getMcpToken,
  getMcpApiUrl,
  getMcpCommand,

  /**
   * Registers the mailbox MCP server for every provider that reads CloudCLI's
   * managed MCP config, unconditionally — this tool has no settings toggle,
   * it is always available to every interactive session. The per-session
   * identity (CLOUDCLI_SESSION_ID/PROJECT_PATH/PROVIDER) is NOT set here —
   * this env block is shared by every session of a provider. It is instead
   * injected per-run into the provider CLI's own subprocess env (see
   * claude-sdk.js / grok-cli.js / opencode-cli.js), which the CLI then passes
   * down to the MCP servers it spawns.
   */
  async registerAgentMcp(): Promise<{ name: string; results: unknown }> {
    const { command, args } = getMcpCommand();
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_SESSION_MAILBOX_MCP_TOKEN: getMcpToken(),
        CLOUDCLI_SESSION_MAILBOX_API_URL: getMcpApiUrl(),
      },
    });
    return { name: MCP_SERVER_NAME, results };
  },

  /** Test-only escape hatch: clears every in-memory mailbox structure. */
  clearAllForTests(): void {
    messagesById.clear();
    inboxBySession.clear();
    sendTimestamps.clear();
    replyWaiters.clear();
    runtimeSpawnFns = {};
    runtimeInjectFns = {};
  },
};

export const SESSION_MAILBOX_MCP_SERVER_NAME = MCP_SERVER_NAME;
