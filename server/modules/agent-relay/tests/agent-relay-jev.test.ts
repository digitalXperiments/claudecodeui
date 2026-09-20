import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  agentRelayPermissionBroker,
  configureRelayPermissionResolver,
} from '@/modules/agent-relay/agent-relay-permission.service.js';
import { agentRelayDb } from '@/modules/agent-relay/agent-relay.repository.js';
import {
  adjudicatePermission,
  applyPermissionAdvice,
  type JevPermissionAdvice,
} from '@/modules/agent-relay/jev-relay.service.js';
import {
  configureJevTransport,
  type JevRequest,
  type JevSettings,
} from '@/modules/decisioning/index.js';
import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { newRelayBatchId, newRelayJobId } from '@/shared/ids.js';
import { makeScratchDir } from '@/shared/scratch.js';

const WORKTREE = '/workspace/relay-worktree';

/** Every capability on, so each test can turn exactly one guardrail back off. */
function config(overrides: Partial<JevSettings> = {}): JevSettings {
  return {
    enabled: true,
    model: 'jev-latest',
    baseUrl: 'https://api.typesafe.ai',
    timeoutMs: 4_000,
    confidenceThreshold: 0.85,
    relayMayApprovePermissions: true,
    ...overrides,
    capabilities: {
      relay_permissions: 'enforcing',
      relay_results: 'enforcing',
      browser_page_state: 'off',
      ...(overrides.capabilities ?? {}),
    },
  };
}

/** Shorthand for the common "turn one capability down" case. */
function withPermissions(mode: 'off' | 'shadow' | 'enforcing', overrides: Partial<JevSettings> = {}): JevSettings {
  return config({
    ...overrides,
    capabilities: { relay_permissions: mode, relay_results: 'enforcing', browser_page_state: 'off' },
  });
}

function advice(overrides: Partial<JevPermissionAdvice> = {}): JevPermissionAdvice {
  return {
    verdict: 'approve',
    confidence: 0.99,
    probabilities: {},
    signals: { destructive: 0 },
    latencyMs: 12,
    model: 'jev-latest',
    error: null,
    ...overrides,
  };
}

/** Records every request and answers with a fixed Jev response. */
function stubTransport(answers: Record<string, unknown>, delayMs = 0): { bodies: JevRequest[] } {
  const bodies: JevRequest[] = [];
  configureJevTransport(async ({ body }) => {
    bodies.push(body);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { model: 'jev-latest', answers } as never;
  });
  return { bodies };
}

const permissionInput = {
  mode: 'isolated_write',
  approvalPolicy: 'manual',
  provider: 'claude',
  envelopeRoot: WORKTREE,
  classifierReason: 'manual approval policy requires lead confirmation',
  toolName: 'Bash',
  command: 'npm run build',
  paths: [`${WORKTREE}/src/app.ts`],
  cwd: WORKTREE,
  task: 'Build the project.',
};

// ---------------------------------------------------------------------------
// Guardrails around advice. These are the whole point of the sidecar design:
// Jev may restrict on its own, but it may never widen what Relay allows.
// ---------------------------------------------------------------------------

test('advisory mode never settles anything, however confident Jev is', () => {
  assert.deepEqual(
    applyPermissionAdvice(withPermissions('shadow'), advice({ verdict: 'approve', confidence: 1 })),
    { settle: null, reason: null },
  );
  assert.deepEqual(
    applyPermissionAdvice(withPermissions('shadow'), advice({ verdict: 'deny', confidence: 1 })),
    { settle: null, reason: null },
  );
});

test('advice below the confidence threshold is ignored in both directions', () => {
  const cfg = config({ confidenceThreshold: 0.9 });
  assert.equal(applyPermissionAdvice(cfg, advice({ verdict: 'approve', confidence: 0.89 })).settle, null);
  assert.equal(applyPermissionAdvice(cfg, advice({ verdict: 'deny', confidence: 0.89 })).settle, null);
  assert.equal(applyPermissionAdvice(cfg, advice({ verdict: 'deny', confidence: 0.91 })).settle, 'deny');
});

test('denying needs only enforcing; approving needs the separate approval switch', () => {
  const denyOnly = config({ relayMayApprovePermissions: false });
  assert.equal(applyPermissionAdvice(denyOnly, advice({ verdict: 'deny' })).settle, 'deny');
  assert.equal(applyPermissionAdvice(denyOnly, advice({ verdict: 'approve' })).settle, null);
  assert.equal(applyPermissionAdvice(config(), advice({ verdict: 'approve' })).settle, 'approve');
});

test('a likely-destructive request can never be approved, but can still be denied', () => {
  assert.equal(applyPermissionAdvice(config(), advice({ verdict: 'approve', signals: { destructive: 0.5 } })).settle, null);
  assert.equal(applyPermissionAdvice(config(), advice({ verdict: 'deny', signals: { destructive: 0.9 } })).settle, 'deny');
});

test('an escalate verdict, a failed call, and a missing advice all settle nothing', () => {
  assert.equal(applyPermissionAdvice(config(), advice({ verdict: 'escalate' })).settle, null);
  assert.equal(applyPermissionAdvice(config(), advice({ verdict: 'approve', error: 'timeout' })).settle, null);
  assert.equal(applyPermissionAdvice(config(), null).settle, null);
});

test('advice is inert while the master switch or permission adjudication is off', () => {
  assert.equal(applyPermissionAdvice(config({ enabled: false }), advice({ verdict: 'deny' })).settle, null);
  assert.equal(applyPermissionAdvice(withPermissions('off'), advice({ verdict: 'deny' })).settle, null);
  assert.equal(applyPermissionAdvice(null, advice({ verdict: 'deny' })).settle, null);
});

// ---------------------------------------------------------------------------
// The client call itself
// ---------------------------------------------------------------------------

test('Jev is not called at all while disabled or unconfigured', async (t) => {
  const previousKey = process.env.TYPESAFE_API_KEY;
  // Point the credential lookup at an empty scratch database. Without this the
  // ambient DATABASE_PATH is used, and a real stored key would make the
  // "unconfigured" leg of this test silently pass through to a live call.
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-jev-unconfigured-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const stub = stubTransport({ verdict: { choice: 'approve', confidence: 1 } });
  t.after(async () => {
    configureJevTransport(null);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  });

  process.env.TYPESAFE_API_KEY = 'test-key';
  assert.equal(await adjudicatePermission(config({ enabled: false }), permissionInput), null);
  assert.equal(await adjudicatePermission(withPermissions('off'), permissionInput), null);

  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await adjudicatePermission(config(), permissionInput), null);
  assert.equal(stub.bodies.length, 0, 'no request may be sent while Jev is off or unconfigured');
});

test('a transport failure and an illegal verdict both degrade to escalate', async (t) => {
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => {
    configureJevTransport(null);
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  });

  configureJevTransport(async () => { throw new Error('TypeSafe responded 503'); });
  const failed = await adjudicatePermission(config(), permissionInput);
  assert.equal(failed?.verdict, 'escalate');
  assert.match(failed?.error ?? '', /503/);
  assert.equal(applyPermissionAdvice(config(), failed).settle, null);

  // A verdict outside the enumerated set is not a verdict. Jev may only ever
  // pick from answers Relay defined.
  stubTransport({ verdict: { choice: 'run_it_anyway', confidence: 1 } });
  const illegal = await adjudicatePermission(config(), permissionInput);
  assert.equal(illegal?.verdict, 'escalate');
  assert.equal(illegal?.signals.destructive, 1);
  assert.equal(applyPermissionAdvice(config(), illegal).settle, null);
});

test('the state sent to Jev is a redacted summary, not a transcript', async (t) => {
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  const stub = stubTransport({ verdict: { choice: 'approve', confidence: 1 } });
  t.after(() => {
    configureJevTransport(null);
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  });

  await adjudicatePermission(config(), {
    ...permissionInput,
    command: 'x'.repeat(5_000),
    paths: Array.from({ length: 40 }, (_, index) => `${WORKTREE}/file-${index}.ts`),
  });

  const [body] = stub.bodies;
  assert.ok(body, 'a request was sent');
  assert.ok(!body.state.includes(process.env.TYPESAFE_API_KEY!), 'the key is never part of the state');
  const state = JSON.parse(body.state) as { request: { command: string; paths: string[] } };
  assert.ok(state.request.command.length < 1_000, 'long commands are clipped');
  assert.equal(state.request.paths.length, 12, 'path lists are capped');
  // Only bounded questions, never a free-text prompt.
  assert.deepEqual(Object.keys(body.questions).sort(), ['destructive', 'verdict']);
});

// ---------------------------------------------------------------------------
// Broker integration
// ---------------------------------------------------------------------------

type BrokerFixture = {
  relayId: string;
  projectPath: string;
  decisions: Array<{ requestId: string; allow: boolean }>;
  cleanup: () => Promise<void>;
};

async function withBroker(mode: 'isolated_write', approvalPolicy: 'auto' | 'manual'): Promise<BrokerFixture> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousKey = process.env.TYPESAFE_API_KEY;
  const root = await makeScratchDir('agent-relay-jev-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.TYPESAFE_API_KEY = 'test-key';
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });

  const decisions: Array<{ requestId: string; allow: boolean }> = [];
  configureRelayPermissionResolver((requestId, decision) => {
    decisions.push({ requestId, allow: decision.allow });
  });

  const project = projectsDb.createProjectPath(projectPath).project!;
  const relayId = newRelayJobId();
  agentRelayDb.create({
    relayId,
    batchId: newRelayBatchId(),
    projectId: project.project_id,
    projectPath: project.project_path,
    provider: 'claude',
    mode,
    approvalPolicy,
    task: 'Apply the migration.',
    prompt: 'Apply the migration.',
    mcpServers: [],
    timeoutMs: 60_000,
  });
  getConnection().prepare("UPDATE agent_relay_jobs SET status = 'running' WHERE relay_id = ?").run(relayId);

  return {
    relayId,
    projectPath,
    decisions,
    cleanup: async () => {
      configureRelayPermissionResolver(null);
      configureJevTransport(null);
      agentRelayPermissionBroker.clearAll();
      closeConnection();
      if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabasePath;
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Jev never sees a request the deterministic classifier already settled', async (t) => {
  const fixture = await withBroker('isolated_write', 'auto');
  t.after(fixture.cleanup);
  const stub = stubTransport({ verdict: { choice: 'approve', confidence: 1 } });

  agentRelayPermissionBroker.register({
    relayId: fixture.relayId,
    mode: 'isolated_write',
    approvalPolicy: 'auto',
    provider: 'claude',
    envelopeRoot: fixture.projectPath,
    sourceSessionId: null,
    approvalTimeoutMs: 5_000,
    jev: config(),
  });

  const approved = await agentRelayPermissionBroker.handlePermissionRequest(fixture.relayId, {
    requestId: 'req-read',
    toolName: 'Read',
    input: { file_path: `${fixture.projectPath}/src/app.ts` },
  });
  assert.equal(approved?.allow, true);
  assert.equal(approved?.via, 'policy');

  const denied = await agentRelayPermissionBroker.handlePermissionRequest(fixture.relayId, {
    requestId: 'req-risky',
    toolName: 'Bash',
    input: { command: 'rm -rf /' },
  });
  assert.equal(denied?.allow, false);
  assert.equal(denied?.via, 'policy');

  assert.equal(stub.bodies.length, 0, 'deterministic approvals and denials never reach Jev');
});

test('an enforcing Jev denial settles an escalation without parking the lead', async (t) => {
  const fixture = await withBroker('isolated_write', 'manual');
  t.after(fixture.cleanup);
  stubTransport({ verdict: { choice: 'deny', confidence: 0.97 }, destructive: { noul: 0.8 } });

  agentRelayPermissionBroker.register({
    relayId: fixture.relayId,
    mode: 'isolated_write',
    approvalPolicy: 'manual',
    provider: 'claude',
    envelopeRoot: fixture.projectPath,
    sourceSessionId: null,
    approvalTimeoutMs: 5_000,
    task: 'Apply the migration.',
    jev: config({ relayMayApprovePermissions: false }),
  });

  const outcome = await agentRelayPermissionBroker.handlePermissionRequest(fixture.relayId, {
    requestId: 'req-jev-deny',
    toolName: 'Write',
    input: { file_path: `${fixture.projectPath}/src/app.ts`, content: 'x' },
  });

  assert.equal(outcome?.allow, false);
  assert.equal(outcome?.via, 'jev');
  assert.equal(outcome?.approvalId, null);
  assert.equal(outcome?.jevAdvice?.verdict, 'deny');
  assert.deepEqual(fixture.decisions, [{ requestId: 'req-jev-deny', allow: false }]);
  assert.equal(agentRelayDb.listApprovals({ relayId: fixture.relayId, status: 'pending' }).length, 0);
});

test('advisory mode records the advice but still parks the request for the lead', async (t) => {
  const fixture = await withBroker('isolated_write', 'manual');
  t.after(fixture.cleanup);
  stubTransport({ verdict: { choice: 'approve', confidence: 0.99 }, destructive: { noul: 0.01 } });

  agentRelayPermissionBroker.register({
    relayId: fixture.relayId,
    mode: 'isolated_write',
    approvalPolicy: 'manual',
    provider: 'claude',
    envelopeRoot: fixture.projectPath,
    sourceSessionId: null,
    approvalTimeoutMs: 60_000,
    jev: withPermissions('shadow'),
  });

  const pending = agentRelayPermissionBroker.handlePermissionRequest(fixture.relayId, {
    requestId: 'req-advisory',
    toolName: 'Write',
    input: { file_path: `${fixture.projectPath}/src/app.ts`, content: 'x' },
  });

  // The lead still has to answer: poll until the approval row appears.
  let approvalId: string | null = null;
  for (let attempt = 0; attempt < 50 && !approvalId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    approvalId = agentRelayDb.listApprovals({ relayId: fixture.relayId, status: 'pending', limit: 1 })[0]?.approval_id ?? null;
  }
  assert.ok(approvalId, 'advisory mode must still escalate to the lead');
  agentRelayPermissionBroker.decide(approvalId, { allow: true, decidedBy: 'lead' });

  const outcome = await pending;
  assert.equal(outcome?.allow, true);
  assert.equal(outcome?.via, 'lead', 'the lead settled it, not Jev');
  assert.equal(outcome?.jevAdvice?.verdict, 'approve', 'the recommendation is still recorded');
});

test('a failing Jev call preserves the existing escalation path', async (t) => {
  const fixture = await withBroker('isolated_write', 'manual');
  t.after(fixture.cleanup);
  configureJevTransport(async () => { throw new Error('ECONNREFUSED'); });

  agentRelayPermissionBroker.register({
    relayId: fixture.relayId,
    mode: 'isolated_write',
    approvalPolicy: 'manual',
    provider: 'claude',
    envelopeRoot: fixture.projectPath,
    sourceSessionId: null,
    approvalTimeoutMs: 60_000,
    jev: config(),
  });

  const pending = agentRelayPermissionBroker.handlePermissionRequest(fixture.relayId, {
    requestId: 'req-jev-down',
    toolName: 'Write',
    input: { file_path: `${fixture.projectPath}/src/app.ts`, content: 'x' },
  });

  let approvalId: string | null = null;
  for (let attempt = 0; attempt < 50 && !approvalId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    approvalId = agentRelayDb.listApprovals({ relayId: fixture.relayId, status: 'pending', limit: 1 })[0]?.approval_id ?? null;
  }
  assert.ok(approvalId, 'an unreachable Jev must not swallow the escalation');
  agentRelayPermissionBroker.decide(approvalId, { allow: false, reason: 'Not now.', decidedBy: 'lead' });

  const outcome = await pending;
  assert.equal(outcome?.via, 'lead');
  assert.match(outcome?.jevAdvice?.error ?? '', /ECONNREFUSED/);
});

test('consulting Jev comes out of the approval window, never on top of it', async (t) => {
  const fixture = await withBroker('isolated_write', 'manual');
  t.after(fixture.cleanup);
  // Advisory, so the request always falls through to the (unanswered) lead.
  stubTransport({ verdict: { choice: 'approve', confidence: 0.99 } }, 400);

  agentRelayPermissionBroker.register({
    relayId: fixture.relayId,
    mode: 'isolated_write',
    approvalPolicy: 'manual',
    provider: 'claude',
    envelopeRoot: fixture.projectPath,
    sourceSessionId: null,
    approvalTimeoutMs: 1_500,
    jev: withPermissions('shadow'),
  });

  const startedAt = Date.now();
  const outcome = await agentRelayPermissionBroker.handlePermissionRequest(fixture.relayId, {
    requestId: 'req-budget',
    toolName: 'Write',
    input: { file_path: `${fixture.projectPath}/src/app.ts`, content: 'x' },
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome?.via, 'timeout');
  assert.ok(
    elapsed < 1_500 + 250,
    `the Jev call must be deducted from the lead's window, not added to it (took ${elapsed}ms)`,
  );
});
