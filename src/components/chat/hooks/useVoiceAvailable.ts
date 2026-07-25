import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import {
  browserSpeechSupported,
  readVoiceConfig,
  VOICE_CONFIG_SYNC_EVENT,
} from '../../../hooks/useVoiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a usable STT path (on-device, API, browser speech, or custom base URL).
const STORAGE_KEY = 'uiPreferences';
const SYNC_EVENT = 'ui-preferences:sync';
let healthRequest: Promise<HealthSnapshot> | null = null;

type HealthSnapshot = {
  configured: boolean;
  localStt: boolean;
  api: boolean;
  tts: boolean;
};

function checkVoiceHealth(): Promise<HealthSnapshot> {
  if (healthRequest) return healthRequest;
  const request = authenticatedFetch('/api/voice/health')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      return {
        configured: data?.configured === true,
        localStt: data?.localStt?.available === true,
        api: data?.api === true,
        tts: data?.tts === true || data?.api === true,
      };
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

function readVoiceEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.voiceEnabled === true || parsed?.voiceEnabled === 'true';
  } catch {
    return false;
  }
}

function sttAvailableFromConfigAndHealth(health: HealthSnapshot | null): boolean {
  const config = readVoiceConfig();
  if (config.baseUrl.trim()) return true;
  if (config.sttProvider === 'browser') return browserSpeechSupported();
  if (config.sttProvider === 'local') return health?.localStt === true;
  if (config.sttProvider === 'api') return health?.api === true || Boolean(config.baseUrl.trim());
  // auto
  if (health?.configured) return true;
  if (browserSpeechSupported()) return true;
  return false;
}

export function useVoiceAvailable(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readVoiceEnabled(),
  );
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const update = () => setEnabled(readVoiceEnabled());
    window.addEventListener('storage', update);
    window.addEventListener(SYNC_EVENT, update as EventListener);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(SYNC_EVENT, update as EventListener);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setAvailable(false);
        return;
      }
      const config = readVoiceConfig();
      if (config.baseUrl.trim()) {
        setAvailable(true);
        return;
      }
      if (config.sttProvider === 'browser' && browserSpeechSupported()) {
        setAvailable(true);
        return;
      }
      const id = ++requestId;
      try {
        const health = await checkVoiceHealth();
        if (active && id === requestId) {
          setAvailable(sttAvailableFromConfigAndHealth(health));
        }
      } catch {
        if (active && id === requestId) {
          // Offline health: still allow browser speech in auto/browser mode.
          setAvailable(
            config.sttProvider === 'browser' || config.sttProvider === 'auto'
              ? browserSpeechSupported()
              : false,
          );
        }
      }
    };

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    };
  }, [enabled]);

  return enabled && available;
}
