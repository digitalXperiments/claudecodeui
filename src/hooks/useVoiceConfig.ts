import { useState } from 'react';

/** How speech-to-text is performed. */
export type SttProvider = 'auto' | 'local' | 'browser' | 'api';

export type VoiceConfig = {
  /** auto | local (WhisperKit) | browser (Web Speech API) | api (OpenAI-compatible) */
  sttProvider: SttProvider;
  /** MediaDevices deviceId of the mic to record from. Empty = system default. */
  inputDeviceId: string;
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
};

const STORAGE_KEY = 'voiceConfig';
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';
const DEFAULTS: VoiceConfig = {
  sttProvider: 'auto',
  inputDeviceId: '',
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

const STT_PROVIDERS = new Set<SttProvider>(['auto', 'local', 'browser', 'api']);

function normalizeSttProvider(value: unknown): SttProvider {
  if (typeof value === 'string' && STT_PROVIDERS.has(value as SttProvider)) {
    return value as SttProvider;
  }
  return 'auto';
}

export function readVoiceConfig(): VoiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS };
    const config = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof VoiceConfig)[]) {
      if (key === 'sttProvider') {
        config.sttProvider = normalizeSttProvider(parsed.sttProvider);
        continue;
      }
      if (typeof parsed[key] === 'string') config[key] = parsed[key];
    }
    return config;
  } catch {
    return { ...DEFAULTS };
  }
}

// Headers the voice proxy reads to target a per-user OpenAI-compatible backend.
// Empty fields are omitted so the server's env defaults apply.
export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const c = readVoiceConfig();
  const h: Record<string, string> = {};
  if (c.sttProvider && c.sttProvider !== 'auto') h['x-voice-stt-provider'] = c.sttProvider;
  // When using on-device, force local so the proxy doesn't hit a remote API.
  if (c.sttProvider === 'local') h['x-voice-stt-provider'] = 'local';
  if (c.apiKey) h['x-voice-api-key'] = c.apiKey;
  if (c.sttModel) h['x-voice-stt-model'] = c.sttModel;
  if (c.ttsModel) h['x-voice-tts-model'] = c.ttsModel;
  if (c.ttsVoice) h['x-voice-tts-voice'] = c.ttsVoice;
  if (c.ttsFormat.trim()) h['x-voice-tts-format'] = c.ttsFormat.trim();
  return h;
}

export function browserSpeechSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const SR =
    (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
      .SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  return Boolean(SR);
}

export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceConfig>(() =>
    typeof window === 'undefined' ? { ...DEFAULTS } : readVoiceConfig(),
  );

  const update = (patch: Partial<VoiceConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      if (patch.sttProvider !== undefined) {
        next.sttProvider = normalizeSttProvider(patch.sttProvider);
      }
      try {
        const stored: Partial<VoiceConfig> = { ...next };
        if (next.ttsFormat.trim()) stored.ttsFormat = next.ttsFormat.trim();
        else delete stored.ttsFormat;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
      } catch {
        /* ignore persistence errors */
      }
      return next;
    });
  };

  return { config, update };
}
