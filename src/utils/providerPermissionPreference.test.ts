import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_PERMISSION_PREFERENCE_CHANGED_EVENT,
  readProviderPermissionModePreference,
  writeProviderPermissionModePreference,
} from './providerPermissionPreference';

const installStorage = () => {
  const store = new Map<string, string>();
  const events: Event[] = [];
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  const windowRef = {
    dispatchEvent: (event: Event) => {
      events.push(event);
      return true;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: windowRef, configurable: true });
  return { store, events };
};

test('readProviderPermissionModePreference falls back when nothing is stored', () => {
  installStorage();
  assert.equal(readProviderPermissionModePreference('omp', 'bypassPermissions'), 'bypassPermissions');
});

test('readProviderPermissionModePreference reads the canonical key first', () => {
  const { store } = installStorage();
  store.set('permissionMode-last-omp', 'plan');
  store.set('omp-tools-settings', JSON.stringify({ permissionMode: 'bypassPermissions' }));
  assert.equal(readProviderPermissionModePreference('omp', 'bypassPermissions'), 'plan');
});

test('readProviderPermissionModePreference migrates a value out of the legacy Settings blob once', () => {
  const { store } = installStorage();
  store.set('omp-tools-settings', JSON.stringify({ permissionMode: 'plan', lastUpdated: '2026-01-01' }));

  assert.equal(readProviderPermissionModePreference('omp', 'bypassPermissions'), 'plan');
  // The canonical key is now populated — the composer's own key going forward.
  assert.equal(store.get('permissionMode-last-omp'), 'plan');
});

test('readProviderPermissionModePreference ignores a malformed legacy blob', () => {
  const { store } = installStorage();
  store.set('omp-tools-settings', 'not json');
  assert.equal(readProviderPermissionModePreference('omp', 'bypassPermissions'), 'bypassPermissions');
});

test('writeProviderPermissionModePreference persists the canonical key and notifies listeners', () => {
  const { store, events } = installStorage();
  writeProviderPermissionModePreference('omp', 'plan');

  assert.equal(store.get('permissionMode-last-omp'), 'plan');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, PROVIDER_PERMISSION_PREFERENCE_CHANGED_EVENT);
  assert.deepEqual((events[0] as CustomEvent).detail, { provider: 'omp', mode: 'plan' });
});
