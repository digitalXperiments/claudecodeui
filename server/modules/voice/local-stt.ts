/**
 * On-device speech-to-text for Apple Silicon via WhisperKit (Core ML / Neural Engine)
 * or whisper.cpp as a fallback.
 *
 * Install:  brew install whisperkit-cli
 * Optional: brew install whisper-cpp ffmpeg
 *
 * Models download on first use into ~/.cloudcli/whisperkit/
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LocalSttEngine = 'whisperkit' | 'whisper-cpp';

export type LocalSttStatus = {
  available: boolean;
  engine: LocalSttEngine | null;
  binary: string | null;
  model: string;
  modelCacheDir: string;
  ffmpeg: string | null;
};

const DEFAULT_MODEL = process.env.VOICE_LOCAL_MODEL || 'base';
const CACHE_ROOT = path.join(os.homedir(), '.cloudcli', 'whisperkit');
const MODEL_DIR = process.env.VOICE_LOCAL_MODEL_DIR || path.join(CACHE_ROOT, 'models');
const TOKENIZER_DIR = process.env.VOICE_LOCAL_TOKENIZER_DIR || path.join(CACHE_ROOT, 'tokenizers');

const WHISPERKIT_CANDIDATES = [
  process.env.VOICE_WHISPERKIT_BIN,
  'whisperkit-cli',
  '/opt/homebrew/bin/whisperkit-cli',
  '/usr/local/bin/whisperkit-cli',
].filter(Boolean) as string[];

const WHISPER_CPP_CANDIDATES = [
  process.env.VOICE_WHISPER_CPP_BIN,
  'whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
].filter(Boolean) as string[];

const FFMPEG_CANDIDATES = [
  process.env.VOICE_FFMPEG_BIN,
  'ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
].filter(Boolean) as string[];

let _statusCache: LocalSttStatus | null = null;
let _statusCachedAt = 0;
const STATUS_TTL_MS = 30_000;

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOnPath(command: string): Promise<string | null> {
  if (command.includes(path.sep) || command.startsWith('/')) {
    return (await isExecutable(command)) ? command : null;
  }
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  // Prefer Homebrew on Apple Silicon when PATH is restricted (e.g. launchd).
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', ...dirs]) {
    const full = path.join(dir, command);
    if (await isExecutable(full)) return full;
  }
  return null;
}

async function firstAvailable(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const resolved = await resolveOnPath(c);
    if (resolved) return resolved;
  }
  return null;
}

export async function getLocalSttStatus(force = false): Promise<LocalSttStatus> {
  const now = Date.now();
  if (!force && _statusCache && now - _statusCachedAt < STATUS_TTL_MS) {
    return _statusCache;
  }

  const whisperkit = await firstAvailable(WHISPERKIT_CANDIDATES);
  const whisperCpp = whisperkit ? null : await firstAvailable(WHISPER_CPP_CANDIDATES);
  const ffmpeg = await firstAvailable(FFMPEG_CANDIDATES);
  const engine: LocalSttEngine | null = whisperkit ? 'whisperkit' : whisperCpp ? 'whisper-cpp' : null;
  const binary = whisperkit || whisperCpp || null;

  _statusCache = {
    available: Boolean(binary),
    engine,
    binary,
    model: DEFAULT_MODEL,
    modelCacheDir: MODEL_DIR,
    ffmpeg,
  };
  _statusCachedAt = now;
  return _statusCache;
}

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.VOICE_TIMEOUT_MS) || 300_000);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Local STT timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const NATIVE_EXTS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.aiff', '.aif', '.caf']);

function extensionFor(filename: string, mimeType: string): string {
  const fromName = path.extname(filename || '').toLowerCase();
  if (fromName) return fromName;
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
  if (mimeType.includes('wav')) return '.wav';
  return '.webm';
}

async function ensureWav(
  inputPath: string,
  ext: string,
  workDir: string,
  ffmpeg: string | null,
): Promise<string> {
  if (NATIVE_EXTS.has(ext) && ext !== '.webm' && ext !== '.ogg') {
    // WhisperKit accepts wav/mp3/m4a/flac; aiff/caf via mac may work — convert if unsure
    if (['.wav', '.mp3', '.m4a', '.flac'].includes(ext)) return inputPath;
  }
  if (!ffmpeg) {
    throw new Error(
      'Local STT needs ffmpeg to convert browser recordings (webm/ogg). Install with: brew install ffmpeg',
    );
  }
  const outPath = path.join(workDir, 'audio.wav');
  const result = await run(ffmpeg, [
    '-y',
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outPath,
  ], { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`ffmpeg conversion failed: ${result.stderr.slice(-400) || result.stdout.slice(-400)}`);
  }
  return outPath;
}

async function transcribeWhisperKit(
  binary: string,
  audioPath: string,
  model: string,
  workDir: string,
): Promise<string> {
  await mkdir(MODEL_DIR, { recursive: true });
  await mkdir(TOKENIZER_DIR, { recursive: true });
  const reportDir = path.join(workDir, 'report');
  await mkdir(reportDir, { recursive: true });

  const args = [
    'transcribe',
    '--model',
    model,
    '--audio-path',
    audioPath,
    '--download-model-path',
    MODEL_DIR,
    '--download-tokenizer-path',
    TOKENIZER_DIR,
    '--skip-special-tokens',
    '--without-timestamps',
    // Stricter thresholds cut Whisper's classic "looping" hallucinations on silence/noise.
    '--no-speech-threshold',
    '0.6',
    '--compression-ratio-threshold',
    '2.4',
    '--temperature',
    '0',
    '--report',
    '--report-path',
    reportDir,
  ];

  const result = await run(binary, args, { timeoutMs: Number(process.env.VOICE_LOCAL_TIMEOUT_MS) || 120_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).slice(-800);
    throw new Error(`whisperkit-cli failed (exit ${result.code}): ${detail || 'unknown error'}`);
  }

  // Prefer structured report JSON
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(reportDir);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    if (jsonFile) {
      const raw = await readFile(path.join(reportDir, jsonFile), 'utf8');
      const data = JSON.parse(raw) as { text?: string };
      if (typeof data.text === 'string') return sanitizeTranscript(data.text.trim());
    }
  } catch {
    /* fall through to stdout parse */
  }

  const match = result.stdout.match(/Transcription of [^:]+:\s*([\s\S]*?)(?:\n\n|\nTranscription Performance|\n$)/);
  if (match) return sanitizeTranscript(match[1].trim());

  // Last non-empty line after "Transcription of"
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const idx = lines.findIndex((l) => l.startsWith('Transcription of'));
  if (idx >= 0 && lines[idx + 1] && !lines[idx + 1].startsWith('Transcription')) {
    return sanitizeTranscript(lines[idx + 1]);
  }
  const afterColon = lines[idx]?.split(':').slice(1).join(':').trim();
  return sanitizeTranscript(afterColon || '');
}

/**
 * Collapse Whisper-style repetition loops ("thank you thank you thank you…")
 * and drop pure garbage so the input box never fills with infinite loops.
 */
function sanitizeTranscript(text: string): string {
  if (!text) return '';
  let t = text.replace(/\s+/g, ' ').trim();

  // Repeated single word: "you you you you"
  t = t.replace(/\b(\w+)(?:\s+\1){3,}\b/gi, '$1');

  // Repeated multi-word phrase (2–8 words) thrice or more
  t = t.replace(/\b((?:\w+\s+){1,7}\w+)(?:\s+\1){2,}\b/gi, '$1');

  // If still dominated by the same short token, treat as no speech
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8) {
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top / words.length >= 0.6) return '';
  }

  return t.trim();
}

async function transcribeWhisperCpp(
  binary: string,
  audioPath: string,
  model: string,
): Promise<string> {
  // whisper-cli expects a ggml model path; VOICE_LOCAL_WHISPER_CPP_MODEL can point at one.
  const modelPath = process.env.VOICE_LOCAL_WHISPER_CPP_MODEL || model;
  const args = ['-m', modelPath, '-f', audioPath, '-nt', '-np'];
  const result = await run(binary, args);
  if (result.code !== 0) {
    throw new Error(
      `whisper-cli failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-600)}. ` +
        'Set VOICE_LOCAL_WHISPER_CPP_MODEL to a ggml .bin path.',
    );
  }
  return (result.stdout || '').trim();
}

/**
 * Transcribe an in-memory audio buffer with the best available local engine.
 */
export async function transcribeLocal(
  buffer: Buffer,
  options: { filename?: string; mimeType?: string; model?: string } = {},
): Promise<{ text: string; engine: LocalSttEngine }> {
  const status = await getLocalSttStatus(true);
  if (!status.available || !status.binary || !status.engine) {
    throw new Error(
      'No local STT engine found. On Apple Silicon install WhisperKit: brew install whisperkit-cli',
    );
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-stt-'));
  try {
    const ext = extensionFor(options.filename || '', options.mimeType || '');
    const rawPath = path.join(workDir, `input${ext}`);
    await writeFile(rawPath, buffer);
    const audioPath = await ensureWav(rawPath, ext, workDir, status.ffmpeg);
    const model = (options.model || status.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

    let text: string;
    if (status.engine === 'whisperkit') {
      text = await transcribeWhisperKit(status.binary, audioPath, model, workDir);
    } else {
      text = await transcribeWhisperCpp(status.binary, audioPath, model);
    }
    return { text: text.trim(), engine: status.engine };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
