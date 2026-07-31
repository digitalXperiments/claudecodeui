import os from 'node:os';

import { agentRunProfilesDb, projectsDb } from '@/modules/database/index.js';
import type { AgentRunProfile } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import { expandMcpSelectionsToTools, mergeToolAllowLists } from '@/shared/mcp-tool-expand.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import type {
  WebhookIngestPayload,
  WebhookSource,
} from '@/modules/webhooks/webhooks.types.js';

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureWebhookRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

export function getWebhookSpawnFn(provider: LLMProvider): ProviderSpawnFn | undefined {
  return runtimeSpawnFns[provider];
}

/** Exported for tests. */
export function buildWebhookPrompt(
  source: WebhookSource,
  payload: WebhookIngestPayload,
  deliveryId: string,
): string {
  const timestamp = new Date().toISOString();
  const text =
    payload.text ||
    (typeof payload.payload === 'string'
      ? payload.payload
      : payload.payload && typeof payload.payload === 'object'
        ? JSON.stringify(payload.payload, null, 2)
        : '');
  const payloadJson = JSON.stringify(
    {
      source: payload.source,
      title: payload.title,
      text: payload.text,
      payload: payload.payload,
      meta: payload.meta,
    },
    null,
    2,
  );

  let template = source.prompt?.trim() || 'Process the following webhook payload:\n\n{{text}}';

  const skills = source.skills?.filter(Boolean) ?? [];
  if (skills.length > 0) {
    template =
      `Apply these project skills for context: ${skills.join(', ')}.\n\n` + template;
  }

  return template
    .replaceAll('{{text}}', text)
    .replaceAll('{{payload}}', payloadJson)
    .replaceAll('{{source}}', payload.source || source.source)
    .replaceAll('{{title}}', payload.title || '')
    .replaceAll('{{timestamp}}', timestamp)
    .replaceAll('{{delivery_id}}', deliveryId);
}

function resolveProjectPath(source: WebhookSource): string {
  if (source.scope === 'project' && source.project_id) {
    const path = projectsDb.getProjectPathById(source.project_id);
    if (!path) {
      throw new AppError('Project path not found for webhook source', {
        code: 'WEBHOOK_PROJECT_PATH_MISSING',
        statusCode: 400,
      });
    }
    return path;
  }
  return os.homedir();
}

function resolveProfile(source: WebhookSource): AgentRunProfile | null {
  if (!source.profile_id) return null;
  return agentRunProfilesDb.get(source.profile_id);
}

/** Exported for tests. */
export function buildRuntimeOptions(
  source: WebhookSource,
  profile: AgentRunProfile | null,
): AnyRecord {
  const provider = (profile?.provider || source.provider) as LLMProvider;
  const permissionMode =
    profile?.permission_mode || source.permission_mode || 'bypassPermissions';

  const profileTools = profile?.tools ?? {};
  const mcpServers = Array.isArray(source.mcp_tools) ? source.mcp_tools : [];
  const profileMcp = Array.isArray(profileTools.mcpServers)
    ? (profileTools.mcpServers as string[])
    : [];
  const allMcp = [...new Set([...mcpServers, ...profileMcp])];

  const expandedMcp = expandMcpSelectionsToTools(allMcp, provider);
  const allowedCommands = mergeToolAllowLists(
    profileTools.allowedCommands as string[] | undefined,
    expandedMcp,
  );
  const disallowed = Array.isArray(profileTools.disallowedCommands)
    ? (profileTools.disallowedCommands as string[])
    : [];

  const options: AnyRecord = { permissionMode, unattended: true };

  if (allMcp.length > 0) {
    options.mcpServers = allMcp;
  }

  const model = profile?.model || source.model;
  if (model) {
    options.model = model;
  }
  if (profile?.effort && profile.effort !== 'default') {
    options.effort = profile.effort;
  }

  switch (provider) {
    case 'claude':
    case 'cursor':
      options.toolsSettings = {
        allowedTools: allowedCommands,
        disallowedTools: disallowed,
        skipPermissions: permissionMode === 'bypassPermissions',
      };
      break;
    case 'grok':
      options.toolsSettings = {
        allowedCommands,
        disallowedCommands: disallowed,
      };
      break;
    default:
      break;
  }

  return options;
}

type RunOutcome = {
  text: string;
  failed: boolean;
  errorMessage: string | null;
};

/** Local copy of MC extract — keeps webhooks decoupled from mission-control. */
export function extractWebhookRunOutcome(appSessionId: string): RunOutcome {
  const events = chatRunRegistry.replayEvents(appSessionId, 0);
  const textChunks: string[] = [];
  const deltaChunks: string[] = [];
  const errorChunks: string[] = [];
  let failed = false;
  for (const event of events) {
    if (event.kind === 'complete') {
      if (typeof event.exitCode === 'number' && event.exitCode !== 0) {
        failed = true;
      }
      continue;
    }
    if (typeof event.content !== 'string') continue;
    if (event.kind === 'error') {
      errorChunks.push(event.content);
    } else if (event.kind === 'text') {
      textChunks.push(event.content);
    } else if (event.kind === 'stream_delta') {
      deltaChunks.push(event.content);
    }
  }
  return {
    text: (textChunks.length > 0 ? textChunks.join('\n') : deltaChunks.join('')).trim(),
    failed,
    errorMessage: errorChunks.join('\n').trim() || null,
  };
}

export type WebhookRunStartResult = {
  deliveryId: string;
  appSessionId: string;
  source: string;
  /** Present when wait=true — settles when the provider run completes. */
  completion: Promise<{ success: boolean; text: string; errorMessage: string | null }>;
};

/**
 * Create a delivery, start a headless provider run, return immediately.
 * Status is finalized by webhooks-automation onRunComplete (and by the
 * completion promise when the caller awaits wait mode).
 */
export async function startWebhookDelivery(params: {
  source: WebhookSource;
  payload: WebhookIngestPayload;
}): Promise<WebhookRunStartResult> {
  const { source, payload } = params;

  if (!source.enabled) {
    throw new AppError(`Webhook source "${source.source}" is disabled`, {
      code: 'WEBHOOK_DISABLED',
      statusCode: 400,
    });
  }

  const profile = resolveProfile(source);
  const provider = (profile?.provider || source.provider) as LLMProvider;
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" runtime is not available`, {
      code: 'WEBHOOK_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const projectPath = resolveProjectPath(source);
  const created = sessionsService.createAppSession(provider, projectPath);
  const appSessionId = created.sessionId;

  const delivery = webhooksDb.createDelivery({
    sourceId: source.source_id,
    request: {
      source: payload.source,
      title: payload.title,
      text: payload.text.slice(0, 4000),
      hasPayload: payload.payload != null && payload.payload !== '',
      meta: payload.meta,
    },
    status: 'accepted',
    appSessionId,
  });

  const prompt = buildWebhookPrompt(source, payload, delivery.delivery_id);
  const options = buildRuntimeOptions(source, profile);

  const result = await startProviderRun({
    appSessionId,
    provider,
    providerSessionId: null,
    projectPath,
    spawnFn,
    content: prompt,
    options,
    connection: DETACHED_CONNECTION,
    userId: null,
  });

  if (!result.ok) {
    webhooksDb.finishDelivery(delivery.delivery_id, 'failed', {
      errorMessage: 'A run is already in progress for this session',
    });
    throw new AppError('A run is already in progress for this session', {
      code: 'WEBHOOK_RUN_IN_PROGRESS',
      statusCode: 409,
    });
  }

  webhooksDb.markDeliveryRunning(delivery.delivery_id, appSessionId);

  const completion = (async () => {
    await result.completion;
    const outcome = extractWebhookRunOutcome(appSessionId);
    // Automation may already have finished the delivery; finish is idempotent enough
    // for concurrent updates (last write wins on status fields).
    const preview = outcome.text.slice(0, 2000) || null;
    if (outcome.failed) {
      webhooksDb.finishDelivery(delivery.delivery_id, 'failed', {
        errorMessage: outcome.errorMessage || 'Provider run failed',
        resultPreview: preview,
      });
    } else {
      webhooksDb.finishDelivery(delivery.delivery_id, 'done', {
        errorMessage: null,
        resultPreview: preview,
      });
    }
    return {
      success: !outcome.failed,
      text: outcome.text,
      errorMessage: outcome.errorMessage,
    };
  })();

  // Detached fire-and-forget: still attach a catch so unhandled rejections don't crash.
  void completion.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Webhooks] delivery completion error', {
      deliveryId: delivery.delivery_id,
      error: message,
    });
    try {
      webhooksDb.finishDelivery(delivery.delivery_id, 'failed', {
        errorMessage: message,
      });
    } catch {
      // best-effort
    }
  });

  return {
    deliveryId: delivery.delivery_id,
    appSessionId,
    source: source.source,
    completion,
  };
}
