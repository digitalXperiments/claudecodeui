import { useCallback, useEffect, useRef, useState } from 'react';

import { readVoiceConfig } from '../../../hooks/useVoiceConfig';
import {
  isBrowserSpeechAvailable,
  joinTranscripts,
  startBrowserSpeech,
  type BrowserSpeechSession,
} from '../../../lib/browserSpeech';
import { transcribeVoice } from '../../../lib/voiceApi';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** Client-side cap so the mic spinner cannot spin forever on a hung local STT job. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

// WhisperKit (and Whisper generally) returns empty text for very short clips — sub-~1.2s
// utterances reliably transcribe to "" and surface as a confusing "No speech detected".
// The mic also warms up for the first fraction of a second, so a quick tap captures mostly
// silence. Reject too-short recordings up front with an actionable message instead.
const MIN_RECORDING_MS = 1200;

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}

/**
 * Open a mic stream, preferring the user-selected input device. If that exact device
 * is unavailable (unplugged, permission scoped elsewhere), fall back to the system
 * default rather than failing the whole recording.
 */
async function acquireMicStream(deviceId: string): Promise<MediaStream> {
  const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: deviceId } },
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      // Only swallow "device not usable" errors; re-throw permission/hardware denials.
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw e;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}

function shouldUseBrowserSpeech(): boolean {
  const { sttProvider } = readVoiceConfig();
  if (sttProvider === 'browser') return isBrowserSpeechAvailable();
  if (sttProvider === 'local' || sttProvider === 'api') return false;
  if (typeof MediaRecorder === 'undefined') return isBrowserSpeechAvailable();
  return false;
}

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/**
 * Push-to-talk dictation.
 * - Default / local / api: MediaRecorder → /api/voice/transcribe (WhisperKit or OpenAI-compatible).
 * - browser: Web Speech API (no upload).
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const stateRef = useRef<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStartRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  const sendRef = useRef(false);
  const browserSessionRef = useRef<BrowserSpeechSession | null>(null);
  const browserFinalsRef = useRef<string[]>([]);
  const modeRef = useRef<'media' | 'browser'>('media');
  const abortRef = useRef<AbortController | null>(null);
  const abortReasonRef = useRef<'user' | 'timeout' | null>(null);
  const browserStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep latest callbacks without re-creating start/stop (avoids re-bind thrash mid-session).
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  const setVoiceState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const abortInFlight = (reason: 'user' | 'timeout' | null = 'user') => {
    abortReasonRef.current = reason;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (browserStopTimerRef.current) {
      clearTimeout(browserStopTimerRef.current);
      browserStopTimerRef.current = null;
    }
  };

  const resetSession = useCallback(() => {
    abortInFlight();
    startingRef.current = false;
    sendRef.current = false;
    try {
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    recordStartRef.current = 0;
    chunksRef.current = [];
    stopTracks();
    browserSessionRef.current?.abort();
    browserSessionRef.current = null;
    browserFinalsRef.current = [];
    setVoiceState('idle');
  }, [setVoiceState]);

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      abortInFlight();
      startingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      browserSessionRef.current?.abort();
      browserSessionRef.current = null;
    };
  }, []);

  const finishWithTranscript = useCallback(
    (text: string, shouldSend: boolean) => {
      if (cancelledRef.current) return;
      const cleaned = text.trim();
      if (cleaned) onTranscriptRef.current(cleaned, shouldSend);
      else onErrorRef.current?.('No speech detected — speak clearly into the mic and hold a moment longer before releasing.');
      setVoiceState('idle');
    },
    [setVoiceState],
  );

  const startBrowser = useCallback(() => {
    if (startingRef.current || stateRef.current === 'recording' || stateRef.current === 'transcribing') {
      return;
    }
    startingRef.current = true;
    browserFinalsRef.current = [];
    modeRef.current = 'browser';

    const session = startBrowserSpeech({
      onFinal: (text) => {
        if (text) browserFinalsRef.current.push(text);
      },
      onError: (msg) => {
        if (cancelledRef.current) return;
        // Only surface hard errors while we still own the session.
        if (stateRef.current === 'recording' || stateRef.current === 'transcribing') {
          onErrorRef.current?.(msg);
        }
      },
      onEnd: () => {
        // Browser engines often end after a pause. If the user still has "recording"
        // active, restart so dictation continues until they stop. Without this the
        // red square stays on but nothing is captured (feels broken).
        if (cancelledRef.current) return;
        if (stateRef.current !== 'recording') return;
        if (!browserSessionRef.current) return;
        // Restart is handled inside browserSpeech via continuousRestart option.
      },
    });

    startingRef.current = false;
    if (!session) {
      setVoiceState('idle');
      return;
    }
    browserSessionRef.current = session;
    setVoiceState('recording');
  }, [setVoiceState]);

  const startMedia = useCallback(async () => {
    if (startingRef.current || stateRef.current === 'recording' || stateRef.current === 'transcribing') {
      return;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return;

    startingRef.current = true;
    modeRef.current = 'media';
    try {
      const stream = await acquireMicStream(readVoiceConfig().inputDeviceId);
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Bail if user cancelled while permission dialog was open.
      if (stateRef.current !== 'idle' && stateRef.current !== 'recording') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onerror = () => {
        if (cancelledRef.current) return;
        onErrorRef.current?.('Recording failed');
        resetSession();
      };

      rec.onstop = async () => {
        stopTracks();
        if (cancelledRef.current) return;

        const shouldSend = sendRef.current;
        sendRef.current = false;
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        recorderRef.current = null;

        const durationMs = recordStartRef.current ? Date.now() - recordStartRef.current : 0;
        recordStartRef.current = 0;
        if (blob.size < 800 || (durationMs > 0 && durationMs < MIN_RECORDING_MS)) {
          setVoiceState('idle');
          onErrorRef.current?.('Recording too short — hold the mic and speak for at least a second, then release.');
          return;
        }

        setVoiceState('transcribing');
        const controller = new AbortController();
        abortRef.current = controller;
        abortReasonRef.current = null;
        const timer = setTimeout(() => {
          abortReasonRef.current = 'timeout';
          controller.abort();
        }, TRANSCRIBE_TIMEOUT_MS);

        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`, controller.signal);
          if (cancelledRef.current || controller.signal.aborted) {
            if (abortReasonRef.current === 'user') setVoiceState('idle');
            return;
          }
          if (!res.ok) {
            let detail = `transcribe ${res.status}`;
            try {
              const body = await res.json();
              if (body?.error) detail = String(body.error);
            } catch {
              /* ignore */
            }
            throw new Error(detail);
          }
          const data = await res.json();
          if (cancelledRef.current || controller.signal.aborted) {
            if (abortReasonRef.current === 'user') setVoiceState('idle');
            return;
          }
          const text = String(data?.text || '').trim();
          finishWithTranscript(text, shouldSend);
        } catch (e) {
          if (cancelledRef.current) return;
          if (e instanceof Error && e.name === 'AbortError') {
            if (abortReasonRef.current === 'user') {
              setVoiceState('idle');
              return;
            }
            onErrorRef.current?.(
              'Transcription timed out. On-device WhisperKit may still be downloading a model — try again, or use Browser speech in Settings → Voice.',
            );
            setVoiceState('idle');
            return;
          }
          onErrorRef.current?.(
            `Transcription failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          setVoiceState('idle');
        } finally {
          clearTimeout(timer);
          if (abortRef.current === controller) abortRef.current = null;
          abortReasonRef.current = null;
        }
      };

      // timeslice keeps chunks flowing; some engines buffer poorly without it.
      rec.start(250);
      recordStartRef.current = Date.now();
      setVoiceState('recording');
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onErrorRef.current?.(msg);
      setVoiceState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [finishWithTranscript, resetSession, setVoiceState]);

  const start = useCallback(async () => {
    if (shouldUseBrowserSpeech()) startBrowser();
    else await startMedia();
  }, [startBrowser, startMedia]);

  const stop = useCallback(
    (opts?: { send?: boolean }) => {
      sendRef.current = opts?.send ?? false;

      if (modeRef.current === 'browser' && browserSessionRef.current) {
        const shouldSend = sendRef.current;
        sendRef.current = false;
        const session = browserSessionRef.current;
        browserSessionRef.current = null;
        setVoiceState('transcribing');
        try {
          session.stop();
        } catch {
          /* ignore */
        }
        // Web Speech may deliver a final result slightly after stop().
        browserStopTimerRef.current = setTimeout(() => {
          browserStopTimerRef.current = null;
          if (cancelledRef.current) return;
          const text = joinTranscripts(browserFinalsRef.current);
          browserFinalsRef.current = [];
          finishWithTranscript(text, shouldSend);
        }, 350);
        return;
      }

      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          // Flush the current buffer before stop so ondataavailable runs.
          if (typeof rec.requestData === 'function' && rec.state === 'recording') {
            rec.requestData();
          }
          rec.stop();
        } catch {
          resetSession();
          onErrorRef.current?.('Failed to stop recording');
        }
        return;
      }

      // Stuck "recording" with no live recorder (e.g. engine died mid-stream).
      if (stateRef.current === 'recording' || stateRef.current === 'transcribing') {
        resetSession();
      }
    },
    [finishWithTranscript, resetSession, setVoiceState],
  );

  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current === 'recording') {
      stop();
      return;
    }
    if (current === 'transcribing') {
      // Second tap cancels a hung local STT job instead of doing nothing.
      abortInFlight('user');
      resetSession();
      onErrorRef.current?.('Transcription cancelled');
      return;
    }
    if (current === 'idle') {
      void start();
    }
  }, [resetSession, start, stop]);

  return { state, toggle, stop, cancel: resetSession };
}
