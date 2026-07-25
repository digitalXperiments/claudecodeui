/**
 * Browser-native speech recognition (Web Speech API).
 * On Safari / macOS this often uses the system speech stack; Chrome may use a
 * cloud service. No API key required — good zero-config fallback when
 * WhisperKit is not installed on the server.
 */

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isBrowserSpeechAvailable(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

export type BrowserSpeechSession = {
  stop: () => void;
  abort: () => void;
};

/**
 * Start continuous dictation. Calls onFinal with finalized transcript chunks.
 * Restarts automatically after engine pauses until the user stops — without
 * restart, Chrome ends recognition after silence while the UI still shows recording.
 */
export function startBrowserSpeech(options: {
  lang?: string;
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}): BrowserSpeechSession | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    options.onError?.('Browser speech recognition is not supported in this browser.');
    return null;
  }

  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = options.lang || navigator.language || 'en-US';

  let stopped = false;
  let restarting = false;
  /** Count consecutive empty ends; cap restarts so network/permission failures can't spin forever. */
  let emptyRestarts = 0;
  let gotSpeech = false;
  let lastError: string | null = null;

  rec.onresult = (event) => {
    let interimPiece = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const piece = result[0]?.transcript || '';
      if (result.isFinal) {
        const t = piece.trim();
        if (t) {
          gotSpeech = true;
          emptyRestarts = 0;
          options.onFinal(t);
        }
      } else {
        interimPiece += piece;
      }
    }
    if (interimPiece) {
      gotSpeech = true;
      emptyRestarts = 0;
      options.onInterim?.(interimPiece);
    }
  };

  rec.onerror = (event) => {
    if (stopped) return;
    const code = event.error || 'unknown';
    // no-speech / aborted are normal when pausing; keep listening via onend restart.
    if (code === 'aborted' || code === 'no-speech') {
      lastError = null;
      return;
    }
    lastError = code;
    const map: Record<string, string> = {
      'not-allowed': 'Microphone access denied for speech recognition.',
      'service-not-allowed': 'Speech recognition service not allowed.',
      network: 'Speech recognition network error.',
      'audio-capture': 'No microphone available for speech recognition.',
    };
    // Fatal errors: stop restarting so we never busy-loop onend → start → error.
    if (
      code === 'not-allowed' ||
      code === 'service-not-allowed' ||
      code === 'audio-capture' ||
      code === 'network' ||
      code === 'bad-grammar' ||
      code === 'language-not-supported'
    ) {
      stopped = true;
    }
    options.onError?.(map[code] || `Speech recognition error: ${code}`);
  };

  rec.onend = () => {
    if (stopped) {
      options.onEnd?.();
      return;
    }
    // Fatal error already handled — do not restart.
    if (lastError) {
      stopped = true;
      options.onEnd?.();
      return;
    }
    // Cap empty restarts (engine ending without speech) to avoid a tight loop.
    if (!gotSpeech) {
      emptyRestarts += 1;
      if (emptyRestarts > 8) {
        stopped = true;
        options.onError?.('Speech recognition stopped (no speech detected). Tap the mic to try again.');
        options.onEnd?.();
        return;
      }
    } else {
      emptyRestarts = 0;
    }
    // Engine paused (common after silence). Restart until the user stops.
    if (restarting) return;
    restarting = true;
    try {
      rec.start();
    } catch {
      stopped = true;
      options.onEnd?.();
    } finally {
      restarting = false;
    }
  };

  try {
    rec.start();
  } catch (e) {
    options.onError?.(e instanceof Error ? e.message : String(e));
    return null;
  }

  return {
    stop: () => {
      stopped = true;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    },
    abort: () => {
      stopped = true;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Collect finals into one string after a push-to-talk session. */
export function joinTranscripts(parts: string[]): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
