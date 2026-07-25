// Voice proxy — STT/TTS via OpenAI-compatible backends, plus on-device STT.
//
// STT backends (in priority order when none is forced):
//   1. OpenAI-compatible API (VOICE_API_BASE_URL / server env)
//   2. Local Apple Silicon engines (whisperkit-cli / whisper-cli)
//
// Remote backends expose:
//     POST {base}/audio/transcriptions   (multipart 'file' + 'model')      -> { text }
//     POST {base}/audio/speech           ({ model, voice, input })         -> audio bytes
//
// Local STT uses WhisperKit (Core ML / Neural Engine) when `whisperkit-cli` is on PATH:
//     brew install whisperkit-cli
//
// Config is resolved per-request from headers (set by the client's voice settings),
// falling back to server env defaults. Mounted at /api/voice behind authenticateToken.
import { Readable } from 'node:stream';
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { getLocalSttStatus, transcribeLocal } from './modules/voice/local-stt.js';

// Opt-in diagnostics (set VOICE_DEBUG=1). Logs one JSON line per transcribe request and
// saves the raw uploaded audio so a failing recording can be inspected offline.
const VOICE_DEBUG = process.env.VOICE_DEBUG === '1' || process.env.VOICE_DEBUG === 'true';
const VOICE_DEBUG_DIR = process.env.VOICE_DEBUG_DIR || path.join(os.homedir(), '.cloudcli', 'voice-debug');
let _debugCounter = 0;

async function voiceDebugLog(entry, buffer) {
  if (!VOICE_DEBUG) return;
  try {
    await mkdir(VOICE_DEBUG_DIR, { recursive: true });
    let savedAs = null;
    if (buffer && buffer.length) {
      const ext = (entry.mime || '').includes('mp4')
        ? 'm4a'
        : (entry.mime || '').includes('ogg')
          ? 'ogg'
          : 'webm';
      savedAs = path.join(VOICE_DEBUG_DIR, `rec-${_debugCounter++}.${ext}`);
      await writeFile(savedAs, buffer);
    }
    await appendFile(
      path.join(VOICE_DEBUG_DIR, 'transcribe.log'),
      `${JSON.stringify({ t: new Date().toISOString(), ...entry, savedAs })}\n`,
    );
  } catch {
    /* diagnostics must never break the request */
  }
}

const ENV = {
  baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
  apiKey: process.env.VOICE_API_KEY || '',
  sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
  ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
  ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
  // Prefer local STT when no remote base URL is set (default true).
  preferLocal: process.env.VOICE_PREFER_LOCAL !== '0' && process.env.VOICE_PREFER_LOCAL !== 'false',
};

/**
 * Resolve the voice backend config for a request. Client headers (set from the
 * user's in-app voice settings) take precedence over the server env defaults.
 * @param {import('express').Request} req
 */
function resolveConfig(req) {
  const h = req.headers;
  const sttProvider = String(h['x-voice-stt-provider'] || '').trim().toLowerCase();
  return {
    // Security: do not allow clients to control the outbound backend host.
    // Always use the server-side configured base URL.
    baseUrl: ENV.baseUrl,
    apiKey: String(h['x-voice-api-key'] || '') || ENV.apiKey,
    sttModel: String(h['x-voice-stt-model'] || '') || ENV.sttModel,
    ttsModel: String(h['x-voice-tts-model'] || '') || ENV.ttsModel,
    ttsVoice: String(h['x-voice-tts-voice'] || '') || ENV.ttsVoice,
    ttsFormat: String(h['x-voice-tts-format'] || '').trim(),
    // Client can force: local | api | auto (default)
    sttProvider: sttProvider || 'auto',
  };
}

const router = express.Router();

// Generous by default — local TTS can synthesize long messages at ~real-time on CPU.
// Guard against a non-numeric/zero override that would make setTimeout fire immediately.
const DEFAULT_VOICE_TIMEOUT_MS = 300000;
const _parsedTimeout = Number(process.env.VOICE_TIMEOUT_MS);
const VOICE_TIMEOUT_MS = Number.isFinite(_parsedTimeout) && _parsedTimeout > 0
  ? _parsedTimeout
  : DEFAULT_VOICE_TIMEOUT_MS;

/**
 * fetch() with an AbortController timeout so a stalled backend can't hold the
 * request open indefinitely. Aborts after VOICE_TIMEOUT_MS.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !isAllowedBackendUrl(parsed.origin)) {
    throw new Error('Blocked outbound voice backend URL');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  try {
    return await fetch(parsed.toString(), { redirect: 'manual', ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a backend fetch failure into a clear, actionable client response:
 * 504 on timeout (AbortError), 502 otherwise.
 * @param {import('express').Response} res
 * @param {Error} e
 */
function backendError(res, e) {
  if (e && e.name === 'AbortError') {
    return res.status(504).json({
      error: `Voice backend timed out after ${Math.round(VOICE_TIMEOUT_MS / 1000)}s. Check your voice backend.`,
    });
  }
  return res.status(502).json({ error: `Voice backend unreachable: ${e.message}` });
}

/**
 * SSRF guard for the user-configurable backend URL: allow http/https only and
 * block the link-local / cloud-metadata range (169.254.x). localhost and private
 * ranges are allowed on purpose so users can point at a local voice server
 * (LocalAI, Speaches, Kokoro-FastAPI, etc.).
 * @param {string} raw
 * @returns {boolean}
 */
function isAllowedBackendUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === '169.254.169.254' || u.hostname.startsWith('169.254.')) return false;
  return true;
}

/**
 * Relay an upstream (backend) error to the client without making an upstream
 * 401/403 look like the user's own app login failed.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} [text]
 */
function upstreamError(res, status, text) {
  if (status === 401 || status === 403) {
    return res.status(502).json({ error: 'Voice backend rejected the request (check the API key).' });
  }
  return res.status(status).json({ error: text || 'voice backend error' });
}

let _upload = null;
/**
 * Lazily build a memory-storage multer instance (25 MB cap) for audio uploads,
 * so multer is only imported when the voice feature is actually used.
 * @returns {Promise<import('multer').Multer>}
 */
async function getUpload() {
  if (!_upload) {
    const multer = (await import('multer')).default;
    _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  }
  return _upload;
}

/**
 * Build the Authorization header for the backend, or an empty object when no
 * key is configured (e.g. a local server that needs none).
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function authHeader(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Whether this request should use on-device STT.
 * @param {{ baseUrl: string, sttProvider: string }} cfg
 * @param {{ available: boolean }} local
 */
function shouldUseLocalStt(cfg, local) {
  if (cfg.sttProvider === 'local') return true;
  if (cfg.sttProvider === 'api') return false;
  // auto: local when available and no remote base URL (or prefer local)
  if (!local.available) return false;
  if (!cfg.baseUrl) return true;
  return ENV.preferLocal && cfg.sttProvider === 'auto';
}

/**
 * GET /api/voice/health -> capability snapshot for the client.
 */
router.get('/health', async (req, res) => {
  const cfg = resolveConfig(req);
  let local;
  try {
    local = await getLocalSttStatus();
  } catch {
    local = { available: false, engine: null, binary: null, model: '', modelCacheDir: '', ffmpeg: null };
  }
  const apiConfigured = Boolean(cfg.baseUrl);
  const sttReady = apiConfigured || local.available;
  res.json({
    configured: sttReady,
    api: apiConfigured,
    tts: apiConfigured,
    localStt: {
      available: local.available,
      engine: local.engine,
      model: local.model,
      hasFfmpeg: Boolean(local.ffmpeg),
    },
  });
});

/**
 * POST /api/voice/transcribe (multipart 'audio') -> { text }.
 * Uses on-device WhisperKit when available / requested; otherwise OpenAI-compatible API.
 */
router.post('/transcribe', async (req, res) => {
  const cfg = resolveConfig(req);
  const upload = await getUpload();
  upload.single('audio')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });

    let local;
    try {
      local = await getLocalSttStatus();
    } catch {
      local = { available: false };
    }

    const useLocal = shouldUseLocalStt(cfg, local);

    const debugBase = {
      provider: cfg.sttProvider,
      useLocal,
      localAvailable: Boolean(local.available),
      localEngine: local.engine || null,
      mime: req.file.mimetype || null,
      filename: req.file.originalname || null,
      bytes: req.file.size ?? (req.file.buffer ? req.file.buffer.length : 0),
      sttModel: cfg.sttModel || null,
      hasBaseUrl: Boolean(cfg.baseUrl),
    };

    if (useLocal) {
      try {
        // For local path, sttModel may be a WhisperKit name (tiny, base, small, …)
        // rather than OpenAI's whisper-1.
        const localModel =
          cfg.sttModel && !/^whisper-1$/i.test(cfg.sttModel)
            ? cfg.sttModel
            : undefined;
        const result = await transcribeLocal(req.file.buffer, {
          filename: req.file.originalname || 'recording.webm',
          mimeType: req.file.mimetype || 'audio/webm',
          model: localModel,
        });
        await voiceDebugLog(
          { ...debugBase, ok: true, textLen: (result.text || '').length, textPreview: (result.text || '').slice(0, 120), engine: result.engine },
          req.file.buffer,
        );
        return res.json({ text: result.text, engine: result.engine });
      } catch (e) {
        await voiceDebugLog(
          { ...debugBase, ok: false, error: e instanceof Error ? e.message : String(e) },
          req.file.buffer,
        );
        // If user forced local, surface the error; otherwise fall through to API.
        if (cfg.sttProvider === 'local' || !cfg.baseUrl) {
          const message = e instanceof Error ? e.message : String(e);
          if (/timed out/i.test(message)) {
            return res.status(504).json({ error: message });
          }
          return res.status(502).json({ error: message });
        }
      }
    }

    if (!useLocal) {
      await voiceDebugLog({ ...debugBase, note: 'not-using-local; routing to API path' }, req.file.buffer);
    }

    if (!cfg.baseUrl) {
      return res.status(503).json({
        error:
          'No voice backend configured. Install on-device STT (brew install whisperkit-cli) ' +
          'or set VOICE_API_BASE_URL / a Base URL in Settings → Voice.',
      });
    }
    if (!isAllowedBackendUrl(cfg.baseUrl)) {
      return res.status(400).json({ error: 'Invalid voice backend URL.' });
    }

    try {
      const fd = new FormData();
      fd.append(
        'file',
        new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }),
        req.file.originalname || 'recording.webm',
      );
      fd.append('model', cfg.sttModel);
      const r = await fetchWithTimeout(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: authHeader(cfg.apiKey),
        body: fd,
      });
      const text = await r.text();
      if (!r.ok) return upstreamError(res, r.status, text);
      let data;
      try { data = JSON.parse(text); } catch { data = { text }; }
      res.json({ text: data.text ?? '', engine: 'api' });
    } catch (e) {
      backendError(res, e);
    }
  });
});

/**
 * POST /api/voice/tts { text } -> audio bytes.
 * Forwards the text to the backend's /audio/speech endpoint and streams the audio back.
 */
router.post('/tts', async (req, res) => {
  const cfg = resolveConfig(req);
  if (!cfg.baseUrl) return res.status(503).json({ error: 'No voice backend configured for text-to-speech' });
  if (!isAllowedBackendUrl(cfg.baseUrl)) return res.status(400).json({ error: 'Invalid voice backend URL.' });
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const r = await fetchWithTimeout(`${cfg.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(cfg.apiKey) },
      body: JSON.stringify({
        model: cfg.ttsModel,
        voice: cfg.ttsVoice,
        input: text,
        ...(cfg.ttsFormat ? { response_format: cfg.ttsFormat } : {}),
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => 'tts failed');
      return upstreamError(res, r.status, errText);
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on('error', (error) => res.destroy(error)).pipe(res);
  } catch (e) {
    backendError(res, e);
  }
});

export default router;
