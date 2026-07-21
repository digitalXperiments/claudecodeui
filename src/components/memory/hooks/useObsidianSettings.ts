import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  ApiResponse,
  ObsidianConnectionTestResponse,
  ObsidianConnectionTestResult,
  ObsidianMemorySettings,
  ObsidianSettingsResponse,
} from '../types';

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === 'object') {
    const error = (payload as Record<string, unknown>).error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
  }
  return fallback;
};

const DEFAULT_SETTINGS: ObsidianMemorySettings = {
  vaultPath: '',
  restProtocol: 'http',
  restHost: '127.0.0.1',
  restPort: 27123,
  restApiKey: '',
  configured: false,
};

export function useObsidianSettings() {
  const [settings, setSettings] = useState<ObsidianMemorySettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/project-memory/settings');
      const data = await toResponseJson<ApiResponse<ObsidianSettingsResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load Obsidian settings'));
      }
      setSettings({ ...DEFAULT_SETTINGS, ...data.data.settings });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Obsidian settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const save = useCallback(async (next: Partial<ObsidianMemorySettings>) => {
    setSaveStatus(null);
    try {
      const response = await authenticatedFetch('/api/project-memory/settings', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      const data = await toResponseJson<ApiResponse<ObsidianSettingsResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to save Obsidian settings'));
      }
      setSettings({ ...DEFAULT_SETTINGS, ...data.data.settings });
      setSaveStatus('success');
      return data.data.settings;
    } catch (err) {
      setSaveStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to save Obsidian settings');
      throw err;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }
    const timer = window.setTimeout(() => setSaveStatus(null), 4000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  const [testResult, setTestResult] = useState<ObsidianConnectionTestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  /**
   * Probes the Obsidian Local REST API with the *saved* connection settings.
   * Save the form first when values have changed.
   */
  const testConnection = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const response = await authenticatedFetch('/api/project-memory/test-connection', {
        method: 'POST',
      });
      const data = await toResponseJson<ApiResponse<ObsidianConnectionTestResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to test the connection'));
      }
      setTestResult(data.data.result);
      return data.data.result;
    } catch (err) {
      const fallback: ObsidianConnectionTestResult = {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to test the connection',
      };
      setTestResult(fallback);
      return fallback;
    } finally {
      setIsTesting(false);
    }
  }, []);

  return { settings, isLoading, error, saveStatus, refresh, save, testConnection, testResult, isTesting };
}
