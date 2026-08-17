import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT,
  PROVIDER_USAGE_DISABLED_PROVIDERS_KEY,
  PROVIDER_USAGE_LEGEND_COLLAPSED_KEY,
  PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT,
  isProviderUsageVisible,
  readProviderUsageLegendCollapsed,
  readProviderUsageVisibility,
  writeProviderUsageLegendCollapsed,
  writeProviderUsageVisible,
} from './providerUsagePreferences';

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

test('collapse preference defaults to expanded and persists collapsed vs expanded only', () => {
  const { store, events } = installStorage();

  assert.equal(readProviderUsageLegendCollapsed(), false);
  writeProviderUsageLegendCollapsed(true);
  assert.equal(store.get(PROVIDER_USAGE_LEGEND_COLLAPSED_KEY), 'true');
  assert.equal(readProviderUsageLegendCollapsed(), true);
  assert.equal(events[0]?.type, PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT);

  writeProviderUsageLegendCollapsed(false);
  assert.equal(store.get(PROVIDER_USAGE_LEGEND_COLLAPSED_KEY), 'false');
  assert.equal(readProviderUsageLegendCollapsed(), false);
  assert.equal(store.has('show-provider-usage-legend'), false);
});

test('provider visibility defaults on and persists only disabled provider ids', () => {
  const { store, events } = installStorage();

  assert.equal(readProviderUsageVisibility().claude, true);
  assert.equal(isProviderUsageVisible('future-provider'), true);

  writeProviderUsageVisible('claude', false);
  assert.deepEqual(JSON.parse(store.get(PROVIDER_USAGE_DISABLED_PROVIDERS_KEY) ?? '[]'), ['claude']);
  assert.equal(readProviderUsageVisibility().claude, false);
  assert.equal(isProviderUsageVisible('claude'), false);
  assert.equal(events.at(-1)?.type, PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT);

  writeProviderUsageVisible('claude', true);
  assert.deepEqual(JSON.parse(store.get(PROVIDER_USAGE_DISABLED_PROVIDERS_KEY) ?? '[]'), []);
  assert.equal(readProviderUsageVisibility().claude, true);
});

test('malformed visibility storage fails open', () => {
  const { store } = installStorage();
  store.set(PROVIDER_USAGE_DISABLED_PROVIDERS_KEY, '{bad json');
  assert.equal(readProviderUsageVisibility().grok, true);
});
