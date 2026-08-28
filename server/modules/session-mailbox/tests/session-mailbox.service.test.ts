import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';
import { configureSessionMailboxRuntimes, sessionMailboxService } from '@/modules/session-mailbox/session-mailbox.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-mailbox-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    sessionMailboxService.clearAllForTests();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A spawnFn that never resolves, like a live long-running provider run. */
function pendingSpawnFn(calls: string[]): (command: string) => Promise<void> {
  return async (command: string) => {
    calls.push(command);
    await new Promise(() => undefined);
  };
}

/** A spawnFn that resolves immediately, like a fast provider turn completing. */
function instantSpawnFn(calls: string[]): (command: string) => Promise<void> {
  return async (command: string) => {
    calls.push(command);
  };
}

test('listPeerSessions returns other sessions in the same project, excluding self and internal sessions', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'grok', '/workspace/demo');
    sessionsDb.createAppSession('peer-b-internal', 'claude', '/workspace/demo', { internal: true });
    sessionsDb.createAppSession('other-project', 'claude', '/workspace/other');
    sessionsDb.updateSessionCustomName('peer-a', 'Peer A');

    const peers = sessionMailboxService.listPeerSessions('self');

    assert.equal(peers.length, 1);
    assert.equal(peers[0]?.sessionId, 'peer-a');
    assert.equal(peers[0]?.title, 'Peer A');
    assert.equal(peers[0]?.provider, 'grok');
    assert.equal(peers[0]?.busy, false);
  });
});

test('listPeerSessions reflects chatRunRegistry busy state', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'claude', '/workspace/demo');

    chatRunRegistry.startRun({
      appSessionId: 'peer-a',
      provider: 'claude',
      providerSessionId: 'native-a',
      connection: { readyState: -1, send: () => undefined },
      userId: null,
    });

    const peers = sessionMailboxService.listPeerSessions('self');
    assert.equal(peers[0]?.busy, true);
  });
});

test('sendPeerMessage rejects sends across projects', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('other-project', 'claude', '/workspace/other');
    configureSessionMailboxRuntimes({});

    await assert.rejects(
      () => sessionMailboxService.sendPeerMessage({
        fromSessionId: 'self',
        toSessionId: 'other-project',
        message: 'hello',
      }),
      /CROSS_PROJECT_DENIED|same project/i,
    );
  });
});

test('sendPeerMessage rejects sends to self', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    configureSessionMailboxRuntimes({});

    await assert.rejects(
      () => sessionMailboxService.sendPeerMessage({
        fromSessionId: 'self',
        toSessionId: 'self',
        message: 'hello',
      }),
      /INVALID_RECIPIENT/,
    );
  });
});

test('sendPeerMessage rejects messages over the character cap', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'claude', '/workspace/demo');
    configureSessionMailboxRuntimes({});

    await assert.rejects(
      () => sessionMailboxService.sendPeerMessage({
        fromSessionId: 'self',
        toSessionId: 'peer-a',
        message: 'x'.repeat(8001),
      }),
      /MESSAGE_TOO_LONG/,
    );
  });
});

test('sendPeerMessage delivers directly (starts a new turn) when the recipient is idle', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'claude', '/workspace/demo');

    const spawnCalls: string[] = [];
    configureSessionMailboxRuntimes({ claude: instantSpawnFn(spawnCalls) });

    const result = await sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'ping',
    });

    assert.equal(result.delivered, true);
    assert.equal(result.queued, false);
    assert.equal(spawnCalls.length, 1);
    assert.match(spawnCalls[0]!, /Peer message from session/);
    assert.match(spawnCalls[0]!, /ping/);

    // Delivered-live messages do not sit in the recipient's unread inbox.
    const inbox = sessionMailboxService.checkPeerInbox('peer-a');
    assert.equal(inbox.messages.length, 0);
  });
});

test('sendPeerMessage queues the message when the recipient is busy and no inject hook is offered', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'codex', '/workspace/demo');

    const spawnCalls: string[] = [];
    configureSessionMailboxRuntimes({ codex: pendingSpawnFn(spawnCalls) });

    // Occupy peer-a with a live run first (codex has no injectFn wired here).
    await sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'first turn, keeps peer-a busy',
    });
    assert.equal(chatRunRegistry.isProcessing('peer-a'), true);

    const result = await sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'second message while busy',
    });

    assert.equal(result.queued, true);
    assert.equal(result.delivered, false);

    const inbox = sessionMailboxService.checkPeerInbox('peer-a');
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0]?.content, 'second message while busy');
    assert.equal(inbox.messages[0]?.fromSessionId, 'self');

    // check_peer_inbox marks messages read; a second call returns nothing new.
    const second = sessionMailboxService.checkPeerInbox('peer-a');
    assert.equal(second.messages.length, 0);
  });
});

test('sendPeerMessage delivers via injectFn when the recipient is busy but a provider inject hook accepts it', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'claude', '/workspace/demo');

    const spawnCalls: string[] = [];
    const injectCalls: string[] = [];
    configureSessionMailboxRuntimes(
      { claude: pendingSpawnFn(spawnCalls) },
      { claude: async (command: string) => { injectCalls.push(command); return true; } },
    );

    await sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'first turn, keeps peer-a busy',
    });
    assert.equal(chatRunRegistry.isProcessing('peer-a'), true);

    const result = await sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'injected while busy',
    });

    assert.equal(result.delivered, true);
    assert.equal(result.queued, false);
    assert.equal(injectCalls.length, 1);
    assert.match(injectCalls[0]!, /injected while busy/);

    const inbox = sessionMailboxService.checkPeerInbox('peer-a');
    assert.equal(inbox.messages.length, 0);
  });
});

test('rate limit blocks a session past the outbound cap within the window', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'claude', '/workspace/demo');

    const spawnCalls: string[] = [];
    configureSessionMailboxRuntimes({ claude: instantSpawnFn(spawnCalls) });

    for (let i = 0; i < 20; i += 1) {
      await sessionMailboxService.sendPeerMessage({
        fromSessionId: 'self',
        toSessionId: 'peer-a',
        message: `msg ${i}`,
      });
    }

    await assert.rejects(
      () => sessionMailboxService.sendPeerMessage({
        fromSessionId: 'self',
        toSessionId: 'peer-a',
        message: 'one too many',
      }),
      /RATE_LIMITED/,
    );
  });
});

test('replyToPeer threads back to the original sender and resolves a waiting send_peer_message', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'codex', '/workspace/demo');

    const peerSpawnCalls: string[] = [];
    // Only the recipient's provider (codex) is ever spawned here — sending a
    // message dispatches through peer-a's runtime, not self's.
    configureSessionMailboxRuntimes({ codex: instantSpawnFn(peerSpawnCalls) });

    const sendPromise = sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'question for peer-a',
      waitMs: 2000,
    });

    // peer-a reads its (delivered-live) message via the inbox tool is not
    // required here — it already saw the injected turn — and replies.
    const inbox = sessionMailboxService.checkPeerInbox('peer-a');
    assert.equal(inbox.messages.length, 0, 'delivered-live messages are not queued');

    // Find the delivered message id from the sender's perspective instead.
    const sendResultSoFar = await Promise.race([
      sendPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 10)),
    ]) as AnyRecord | null;
    assert.equal(sendResultSoFar, null, 'send should still be waiting for a reply');

    // The messageId is only known to the caller via the tool response, but
    // for this test we recover it by having peer-a reply to the most recent
    // message it can see in its own "sent to me" set is not exposed — instead
    // simulate peer-a already knowing the id (as it would from the injected
    // "Reply via reply_to_peer (messageId=...)" instruction it read).
    const injectedText = peerSpawnCalls[0]!;
    const match = /messageId=([^)]+)\)/.exec(injectedText);
    assert.ok(match, 'injected content includes a reply-to messageId');
    const messageId = match![1]!;

    const replyResult = await sessionMailboxService.replyToPeer({
      fromSessionId: 'peer-a',
      messageId,
      message: 'answer from peer-a',
    });
    assert.equal(replyResult.delivered, true);

    const sendResult = await sendPromise;
    assert.equal(sendResult.timedOut, false);
    assert.equal(sendResult.reply?.content, 'answer from peer-a');
    assert.equal(sendResult.reply?.fromSessionId, 'peer-a');
  });
});

test('sendPeerMessage waitMs times out when no reply arrives', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('self', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('peer-a', 'claude', '/workspace/demo');

    const spawnCalls: string[] = [];
    configureSessionMailboxRuntimes({ claude: instantSpawnFn(spawnCalls) });

    const result = await sessionMailboxService.sendPeerMessage({
      fromSessionId: 'self',
      toSessionId: 'peer-a',
      message: 'no reply coming',
      waitMs: 50,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.reply, null);
  });
});
