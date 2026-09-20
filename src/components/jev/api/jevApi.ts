import { authenticatedFetch } from '../../../utils/api';
import type { JevConnectionTest, JevKeyStatus, JevSettings } from '../types';

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    data?: T;
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok || payload.success === false || payload.data === undefined) {
    const structuredMessage = payload.error && typeof payload.error === 'object'
      ? (payload.error as { message?: unknown }).message
      : null;
    const message = typeof payload.error === 'string'
      ? payload.error
      : typeof structuredMessage === 'string'
        ? structuredMessage
        : typeof payload.message === 'string'
          ? payload.message
          : `Jev request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload.data;
}

export const jevApi = {
  /** Settings and masked key status arrive together to avoid a second round-trip. */
  async get(): Promise<{ settings: JevSettings; key: JevKeyStatus }> {
    return readData<{ settings: JevSettings; key: JevKeyStatus }>(
      await authenticatedFetch('/api/jev/settings'),
    );
  },

  async update(patch: Partial<JevSettings>): Promise<JevSettings> {
    const data = await readData<{ settings: JevSettings }>(await authenticatedFetch('/api/jev/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }));
    return data.settings;
  },

  async setKey(apiKey: string): Promise<JevKeyStatus> {
    const data = await readData<{ key: JevKeyStatus }>(await authenticatedFetch('/api/jev/key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }));
    return data.key;
  },

  async clearKey(): Promise<JevKeyStatus> {
    const data = await readData<{ key: JevKeyStatus }>(await authenticatedFetch('/api/jev/key', {
      method: 'DELETE',
    }));
    return data.key;
  },

  /** Exercises the saved model, base URL, and credential with one question. */
  async test(): Promise<JevConnectionTest> {
    const data = await readData<{ test: JevConnectionTest }>(await authenticatedFetch('/api/jev/test', {
      method: 'POST',
    }));
    return data.test;
  },
};
