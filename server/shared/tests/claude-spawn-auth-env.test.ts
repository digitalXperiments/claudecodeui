import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  applyClaudeSpawnAuthEnv,
  invalidateClaudeSpawnAuthEnvCache,
  resolveClaudeSpawnOAuthToken,
  setClaudeSpawnAuthEnvIoForTests,
} from '../claude-spawn-auth-env.js';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  kill: () => void;
};

const fakeSecuritySpawn = (payloads: Record<string, string | null>) => {
  return ((_cmd: string, args: string[]) => {
    const accountIdx = args.indexOf('-a');
    const account = accountIdx >= 0 ? args[accountIdx + 1] : '__default__';
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.kill = () => undefined;
    queueMicrotask(() => {
      const payload = Object.prototype.hasOwnProperty.call(payloads, account)
        ? payloads[account]
        : payloads.__default__ ?? null;
      if (payload == null) {
        child.emit('close', 44);
        return;
      }
      child.stdout.emit('data', Buffer.from(payload));
      child.emit('close', 0);
    });
    return child;
  }) as ClaudeSpawnIoSpawn;
};

type ClaudeSpawnIoSpawn = typeof import('node:child_process').spawn;

test('resolveClaudeSpawnOAuthToken skips when CLAUDE_CODE_OAUTH_TOKEN is already set', async () => {
  setClaudeSpawnAuthEnvIoForTests({
    platform: () => 'darwin',
    env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'already' }) as NodeJS.ProcessEnv,
  });
  try {
    assert.equal(await resolveClaudeSpawnOAuthToken(), null);
  } finally {
    setClaudeSpawnAuthEnvIoForTests(null);
  }
});

test('resolveClaudeSpawnOAuthToken prefers a live unknown keychain item over an empty username item', async () => {
  const live = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'live-access-token-value',
      refreshToken: 'live-refresh',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  const empty = JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
  });
  setClaudeSpawnAuthEnvIoForTests({
    platform: () => 'darwin',
    env: () => ({}) as NodeJS.ProcessEnv,
    username: () => 'rammanohar',
    homedir: () => '/tmp-home-no-claude',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    spawn: fakeSecuritySpawn({
      rammanohar: empty,
      unknown: live,
    }),
    now: () => Date.now(),
    keychainTimeoutMs: () => 2_000,
  });
  try {
    assert.equal(await resolveClaudeSpawnOAuthToken({}), 'live-access-token-value');
  } finally {
    setClaudeSpawnAuthEnvIoForTests(null);
  }
});

test('applyClaudeSpawnAuthEnv writes CLAUDE_CODE_OAUTH_TOKEN onto sdkOptions.env when native auth is missing', async () => {
  const live = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'spawn-token',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  setClaudeSpawnAuthEnvIoForTests({
    platform: () => 'darwin',
    env: () => ({ PATH: '/usr/bin' }) as NodeJS.ProcessEnv,
    username: () => null,
    homedir: () => '/tmp-home-no-claude',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    spawn: fakeSecuritySpawn({ unknown: live, __default__: live }),
    now: () => Date.now(),
    keychainTimeoutMs: () => 2_000,
  });
  try {
    const sdkOptions: { env?: NodeJS.ProcessEnv } = { env: { PATH: '/usr/bin' } };
    await applyClaudeSpawnAuthEnv(sdkOptions);
    assert.equal(sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN, 'spawn-token');
    assert.equal(sdkOptions.env?.PATH, '/usr/bin');
  } finally {
    setClaudeSpawnAuthEnvIoForTests(null);
  }
});

test('applyClaudeSpawnAuthEnv preserves native auth and avoids injecting CLAUDE_CODE_OAUTH_TOKEN when username keychain is live', async () => {
  const live = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'keychain-live-token',
      refreshToken: 'keychain-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  setClaudeSpawnAuthEnvIoForTests({
    platform: () => 'darwin',
    env: () => ({ PATH: '/usr/bin' }) as NodeJS.ProcessEnv,
    username: () => 'rammanohar',
    homedir: () => '/tmp-home-no-claude',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    spawn: fakeSecuritySpawn({ rammanohar: live }),
    now: () => Date.now(),
    keychainTimeoutMs: () => 2_000,
  });
  try {
    const sdkOptions: { env?: NodeJS.ProcessEnv } = { env: { PATH: '/usr/bin' } };
    await applyClaudeSpawnAuthEnv(sdkOptions);
    // Crucial: CLAUDE_CODE_OAUTH_TOKEN must NOT be set so Claude CLI refreshes tokens automatically
    assert.equal(sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(sdkOptions.env?.USER, 'rammanohar');
    assert.equal(sdkOptions.env?.PATH, '/usr/bin');
  } finally {
    setClaudeSpawnAuthEnvIoForTests(null);
  }
});

test('applyClaudeSpawnAuthEnv caches the Keychain decision for 60s and never caches a miss', async () => {
  const live = JSON.stringify({
    claudeAiOauth: { accessToken: 'cached-token', expiresAt: Date.now() + 3_600_000 },
  });
  let spawns = 0;
  let payload: string | null = live;
  const countingSpawn = ((cmd: string, args: string[]) => {
    spawns += 1;
    return fakeSecuritySpawn({ __default__: payload })(cmd, args);
  }) as ClaudeSpawnIoSpawn;
  let clock = 1_000_000;
  setClaudeSpawnAuthEnvIoForTests({
    platform: () => 'darwin',
    env: () => ({}) as NodeJS.ProcessEnv,
    username: () => 'someone',
    homedir: () => '/tmp-home-no-claude',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    spawn: countingSpawn,
    now: () => clock,
    keychainTimeoutMs: () => 2_000,
  });
  try {
    const first: { env?: NodeJS.ProcessEnv } = { env: {} };
    await applyClaudeSpawnAuthEnv(first);
    const afterFirst = spawns;
    assert.ok(afterFirst > 0);

    const second: { env?: NodeJS.ProcessEnv } = { env: {} };
    await applyClaudeSpawnAuthEnv(second);
    assert.equal(spawns, afterFirst, 'second call within TTL must not spawn `security`');
    assert.equal(second.env?.USER, 'someone');

    clock += 61_000;
    await applyClaudeSpawnAuthEnv({ env: {} });
    assert.ok(spawns > afterFirst, 'expired entry re-reads Keychain');

    const beforeInvalidate = spawns;
    invalidateClaudeSpawnAuthEnvCache();
    await applyClaudeSpawnAuthEnv({ env: {} });
    assert.ok(spawns > beforeInvalidate, 'invalidate forces a re-read');

    // A miss (nothing readable) is not cached.
    payload = null;
    invalidateClaudeSpawnAuthEnvCache();
    const beforeMiss = spawns;
    await applyClaudeSpawnAuthEnv({ env: {} });
    const afterMiss = spawns;
    assert.ok(afterMiss > beforeMiss);
    await applyClaudeSpawnAuthEnv({ env: {} });
    assert.ok(spawns > afterMiss, 'a miss must be retried on the next call');

    // An explicit API key changes the cache key and short-circuits.
    const withKey: { env?: NodeJS.ProcessEnv } = { env: { ANTHROPIC_API_KEY: 'sk-test' } };
    await applyClaudeSpawnAuthEnv(withKey);
    assert.equal(withKey.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    setClaudeSpawnAuthEnvIoForTests(null);
  }
});
