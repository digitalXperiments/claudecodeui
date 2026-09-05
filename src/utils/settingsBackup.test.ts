import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPreferencesBackup,
  isPortablePreferenceKey,
  parsePreferencesBackup,
  restorePreferencesBackup,
} from './settingsBackup';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

test('exports portable preferences without credentials or session data', () => {
  const storage = new MemoryStorage();
  storage.setItem('selected-provider', 'codex');
  storage.setItem('codex-model', 'gpt-5.4');
  storage.setItem('codex-hidden-models', '["small-model"]');
  storage.setItem('auth-token', 'secret-token');
  storage.setItem('voiceConfig', JSON.stringify({ apiKey: 'secret-api-key' }));
  storage.setItem('draft_input_session-1', 'unfinished message');
  storage.setItem('codex-model-session-1', 'session-only-model');

  const backup = createPreferencesBackup(storage, 'https://old.example', '2026-09-04T10:00:00.000Z');

  assert.deepEqual(backup.preferences, {
    'selected-provider': 'codex',
    'codex-model': 'gpt-5.4',
    'codex-hidden-models': '["small-model"]',
  });
  assert.equal(JSON.stringify(backup).includes('secret'), false);
});

test('restores allowed preferences and ignores injected unknown keys', () => {
  const target = new MemoryStorage();
  const contents = JSON.stringify({
    format: 'cloudcli-preferences',
    version: 1,
    exportedAt: '2026-09-04T10:00:00.000Z',
    sourceOrigin: 'https://old.example',
    preferences: {
      theme: 'dark',
      'permissionMode-last-codex': 'bypassPermissions',
      'auth-token': 'injected-token',
      unknown: 'ignored',
    },
  });

  const result = restorePreferencesBackup(target, contents);

  assert.deepEqual(result, { restored: 2, sourceOrigin: 'https://old.example' });
  assert.equal(target.getItem('theme'), 'dark');
  assert.equal(target.getItem('permissionMode-last-codex'), 'bypassPermissions');
  assert.equal(target.getItem('auth-token'), null);
});

test('rejects malformed and unsupported backup files', () => {
  assert.throws(() => parsePreferencesBackup('{nope'), /not valid JSON/);
  assert.throws(
    () => parsePreferencesBackup(JSON.stringify({ format: 'cloudcli-preferences', version: 99 })),
    /not a supported CloudCLI preferences backup/,
  );
});

test('recognizes defaults, model choices, and provider settings only', () => {
  assert.equal(isPortablePreferenceKey('uiPreferences'), true);
  assert.equal(isPortablePreferenceKey('claude-model'), true);
  assert.equal(isPortablePreferenceKey('omp-tools-settings'), true);
  assert.equal(isPortablePreferenceKey('auth-token'), false);
  assert.equal(isPortablePreferenceKey('claude-model-session-id'), false);
});

