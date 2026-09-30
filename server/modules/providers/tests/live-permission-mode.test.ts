import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureLivePermissionModes,
  updateLivePermissionMode,
  waitForPermissionModeUpdate,
} from '../services/live-permission-mode.service.js';

test('live permission changes serialize by app session and use the native session id', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  configureLivePermissionModes({
    claude: async (nativeId, mode, appId) => {
      assert.equal(nativeId, 'native');
      assert.equal(appId, 'app');
      seen.push(mode);
      if (mode === 'default') await blocked;
      return true;
    },
  });
  try {
    const session = { session_id: 'app', provider: 'claude', provider_session_id: 'native' };
    const first = updateLivePermissionMode(session, 'default');
    const second = updateLivePermissionMode(session, 'bypassPermissions');
    await Promise.resolve();
    assert.deepEqual(seen, ['default']);
    assert.equal(waitForPermissionModeUpdate('app'), second);
    release();
    assert.deepEqual(await first, { applied: true });
    assert.deepEqual(await second, { applied: true });
    assert.deepEqual(seen, ['default', 'bypassPermissions']);
    assert.equal(waitForPermissionModeUpdate('app'), undefined);
  } finally {
    release();
    configureLivePermissionModes({});
  }
});

test('unsupported providers and rejected live changes are reported without claiming success', async () => {
  configureLivePermissionModes({ claude: async () => { throw new Error('rejected'); } });
  try {
    assert.deepEqual(await updateLivePermissionMode({ session_id: 'one', provider: 'codex' }, 'plan'), { applied: false });
    assert.deepEqual(await updateLivePermissionMode({ session_id: 'two', provider: 'claude' }, 'plan'), {
      applied: false, error: 'rejected',
    });
    assert.equal(waitForPermissionModeUpdate('two'), undefined);
  } finally {
    configureLivePermissionModes({});
  }
});
