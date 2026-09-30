import { createHash } from 'node:crypto';

import { AppError } from '@/shared/utils.js';

export const DAY_MS = 86_400_000;
export const LEARNING_WINDOW_DAYS = 14;
export const SUPPRESS_REJECTED_DAYS = 30;

export const learningError = (message: string, statusCode = 400, code = 'BOT_LEARNING_INVALID'): AppError =>
  new AppError(message, { code, statusCode });

export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`);

export const shortHash = (text: string): string =>
  createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(text: string, fallback = 'skill'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are', 'was', 'has', 'have', 'new', 'about',
  'into', 'out', 'not', 'all', 'one', 'our', 'its', 'can', 'will', 'just', 'get', 'got', 'now', 'per', 're', 'fwd',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

export function jaccard(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|credential|authorization|cookie|private[_-]?key)/i;

/** Deep copy with secret-looking keys masked (for exports). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(entry)]),
    );
  }
  return value;
}
