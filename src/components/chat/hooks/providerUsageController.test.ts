import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { ProviderUsageResponse } from '../types/providerUsage';
import { PROVIDER_USAGE_POLL_INTERVAL_MS } from '../utils/providerUsage';

import {
  createProviderUsageController,
  shouldNotifyProviderUsageAuthChanged,
  type ProviderUsageFetch,
  type ProviderUsageState,
} from './providerUsageController';

const payload = (providers: ProviderUsageResponse['providers'] = [{
  providerId: 'claude',
  displayName: 'Claude',
  signedIn: true,
  planName: 'Pro',
  primaryWindowId: 'weekly',
  windows: [{
    id: 'weekly',
    label: 'Weekly',
    used: 28,
    limit: 100,
    remaining: 72,
    remainingRatio: 0.72,
    resetsAt: '2026-08-19T00:00:00.000Z',
    unit: 'percent',
  }],
  status: 'ok',
  error: null,
  fetchedAt: '2026-08-15T14:00:00.000Z',
}]): ProviderUsageResponse => ({
  fetchedAt: '2026-08-15T14:00:00.000Z',
  attemptedAt: '2026-08-15T14:00:00.000Z',
  providers,
  cached: false,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

type MountOptions = {
  fetchUsage?: ProviderUsageFetch;
  now?: () => number;
};

const mountController = (options: MountOptions = {}) => {
  const fetches: Array<{ fresh?: boolean; authChange?: boolean }> = [];
  let hidden = false;
  let visibilityListener: (() => void) | null = null;
  let authListener: (() => void) | null = null;
  let pollTick: (() => void) | null = null;
  let intervalMs = 0;
  const states: ProviderUsageState[] = [];

  const controller = createProviderUsageController({
    fetchUsage: async (query) => {
      fetches.push(query);
      if (options.fetchUsage) {
        return options.fetchUsage(query);
      }
      return payload();
    },
    now: options.now ?? (() => Date.now()),
    onState: (state) => {
      states.push(state);
    },
    getDocumentHidden: () => hidden,
    addVisibilityListener: (listener) => {
      visibilityListener = listener;
      return () => {
        visibilityListener = null;
      };
    },
    addAuthChangeListener: (listener) => {
      authListener = listener;
      return () => {
        authListener = null;
      };
    },
    setIntervalFn: ((fn: () => void, ms: number) => {
      pollTick = fn;
      intervalMs = ms;
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    setTimeoutFn: ((_fn: () => void) => {
      return 2 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as typeof clearTimeout,
  });

  return {
    controller,
    fetches,
    states,
    get intervalMs() {
      return intervalMs;
    },
    setHidden(next: boolean) {
      hidden = next;
    },
    tickPoll() {
      pollTick?.();
    },
    resumeVisible() {
      hidden = false;
      visibilityListener?.();
    },
    emitAuthChange() {
      authListener?.();
    },
  };
};

test('mount polling fetches once and schedules a 5-minute cadence', async () => {
  const mount = mountController();
  mount.controller.start();
  await flush();

  assert.equal(mount.fetches.length, 1);
  assert.deepEqual(mount.fetches[0], { fresh: false, authChange: false });
  assert.equal(mount.intervalMs, PROVIDER_USAGE_POLL_INTERVAL_MS);
  assert.equal(mount.controller.getState().data?.providers[0]?.providerId, 'claude');

  mount.tickPoll();
  await flush();
  assert.equal(mount.fetches.length, 2);
  assert.deepEqual(mount.fetches[1], { fresh: false, authChange: false });
  mount.controller.stop();
});

test('hidden-page pause skips the interval and resume refetches', async () => {
  const mount = mountController();
  mount.controller.start();
  await flush();
  assert.equal(mount.fetches.length, 1);

  mount.setHidden(true);
  mount.tickPoll();
  await flush();
  assert.equal(mount.fetches.length, 1, 'polls do not run while the page is hidden');

  mount.resumeVisible();
  await flush();
  assert.equal(mount.fetches.length, 2, 'becoming visible resumes with a cache-if-fresh poll');
  assert.deepEqual(mount.fetches[1], { fresh: false, authChange: false });
  mount.controller.stop();
});

test('auth-change refresh requests authChange=1 and is not treated as a manual stampede', async () => {
  const mount = mountController();
  mount.controller.start();
  await flush();

  mount.emitAuthChange();
  await flush();
  assert.equal(mount.fetches.length, 2);
  assert.deepEqual(mount.fetches[1], { fresh: true, authChange: true });
  mount.controller.stop();
});

test('cold snapshot with fetchedAt:null does not start the 15s guard', async () => {
  const cold: ProviderUsageResponse = {
    fetchedAt: null,
    attemptedAt: '2026-08-15T14:00:00.000Z',
    providers: [],
    cached: false,
  };
  const now = Date.parse('2026-08-15T14:00:00.000Z');
  const mount = mountController({
    now: () => now,
    fetchUsage: async () => cold,
  });
  mount.controller.start();
  await flush();
  assert.equal(mount.fetches.length, 1);
  assert.equal(mount.controller.getState().data?.fetchedAt, null);
  assert.equal(mount.controller.getState().refreshNotice, null);

  const result = await mount.controller.refresh();
  await flush();
  assert.equal(mount.fetches.length, 2, 'cold null fetchedAt must not suppress manual refresh');
  assert.deepEqual(mount.fetches[1], { fresh: true, authChange: false });
  assert.equal(result?.fetchedAt, null);
  assert.equal(mount.controller.getState().refreshNotice, null);
  mount.controller.stop();
});

test('manual refresh is disabled by the 15s guard and surfaces just updated', async () => {
  const now = Date.parse('2026-08-15T14:00:00.000Z');
  const mount = mountController({ now: () => now });
  mount.controller.start();
  await flush();
  assert.equal(mount.fetches.length, 1);

  const result = await mount.controller.refresh();
  assert.equal(mount.fetches.length, 1);
  assert.equal(result?.providers[0]?.providerId, 'claude');
  assert.equal(mount.controller.getState().refreshNotice, 'just updated');
  mount.controller.stop();
});

test('manual refresh after the 15s window fetches with fresh=1', async () => {
  let now = Date.parse('2026-08-15T14:00:00.000Z');
  const mount = mountController({ now: () => now });
  mount.controller.start();
  await flush();

  now += 16_000;
  await mount.controller.refresh();
  await flush();
  assert.equal(mount.fetches.length, 2);
  assert.deepEqual(mount.fetches[1], { fresh: true, authChange: false });
  mount.controller.stop();
});

test('manual refresh marks refreshing until the in-flight fetch resolves', async () => {
  let now = Date.parse('2026-08-15T14:00:00.000Z');
  const deferred = {
    resolve: (_value: ProviderUsageResponse): void => {
      throw new Error('refresh resolver was not set');
    },
  };
  const mount = mountController({
    now: () => now,
    fetchUsage: async (query) => {
      if (query.fresh && !query.authChange) {
        return new Promise<ProviderUsageResponse>((resolve) => {
          deferred.resolve = resolve;
        });
      }
      return payload();
    },
  });
  mount.controller.start();
  await flush();
  assert.equal(mount.controller.getState().refreshing, false);
  assert.equal(mount.controller.getState().data?.providers[0]?.providerId, 'claude');

  now += 16_000;
  const refreshPromise = mount.controller.refresh();
  await flush();
  assert.equal(mount.controller.getState().refreshing, true);

  deferred.resolve(payload());
  await refreshPromise;
  await flush();
  assert.equal(mount.controller.getState().refreshing, false);
  mount.controller.stop();
});

test('first auth observation does not notify; later boolean flips do', () => {
  assert.equal(shouldNotifyProviderUsageAuthChanged(undefined, false), false);
  assert.equal(shouldNotifyProviderUsageAuthChanged(undefined, true), false);
  assert.equal(shouldNotifyProviderUsageAuthChanged(false, false), false);
  assert.equal(shouldNotifyProviderUsageAuthChanged(true, true), false);
  assert.equal(shouldNotifyProviderUsageAuthChanged(false, true), true);
  assert.equal(shouldNotifyProviderUsageAuthChanged(true, false), true);
});

test('auth-change notify is computed outside the React setState updater', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../provider-auth/hooks/useProviderAuthStatus.ts'),
    'utf8',
  );
  assert.match(source, /observedAuthRef/);
  assert.match(source, /shouldNotifyProviderUsageAuthChanged\(/);
  assert.doesNotMatch(
    source,
    /setProviderAuthStatus\(\(previous\) => \{[\s\S]*notifyProviderUsageAuthChanged/,
  );
  assert.match(source, /if \(shouldNotify\) \{\s*notifyProviderUsageAuthChanged/s);
});
