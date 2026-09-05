import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

export const MAX_CAPTURE_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_EVENTS = 500;

type CaptureEvent = {
  type: 'click' | 'scroll' | 'input';
  at: number;
  x?: number;
  y?: number;
  target?: string;
  valueLength?: number;
};

export type BrowserCaptureInput = {
  projectId: string;
  title: string;
  url: string;
  screenshotDataUrl?: string;
  selectedText?: string;
  selectedSource?: string;
  element?: { selector?: string; tagName?: string; text?: string };
  expectedBehavior?: string;
  reproduction?: { events?: CaptureEvent[]; startedAt?: number; stoppedAt?: number };
};

export type ValidatedBrowserCapture = Omit<BrowserCaptureInput, 'screenshotDataUrl'> & {
  screenshot?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Buffer };
};

const ALLOWED_IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
] as const);

function boundedString(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new CaptureValidationError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max) {
    throw new CaptureValidationError(`${name} must be a string of at most ${max} characters`);
  }
  return value.trim() || (required ? (() => { throw new CaptureValidationError(`${name} is required`); })() : undefined);
}

function validateUrl(value: unknown, name: string): string {
  const raw = boundedString(value, name, 2_048, true)!;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new CaptureValidationError(`${name} must be a valid URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CaptureValidationError(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) throw new CaptureValidationError(`${name} must not contain credentials`);
  return parsed.toString();
}

export class CaptureValidationError extends Error {
  statusCode = 400;
  code = 'BROWSER_CAPTURE_INVALID';
}

export function validateBrowserCapture(input: unknown): ValidatedBrowserCapture {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CaptureValidationError('JSON body is required');
  const body = input as Record<string, unknown>;
  const screenshotDataUrl = boundedString(body.screenshotDataUrl, 'screenshotDataUrl', MAX_SCREENSHOT_BYTES * 2);
  let screenshot: ValidatedBrowserCapture['screenshot'];
  if (screenshotDataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(screenshotDataUrl);
    if (!match) throw new CaptureValidationError('screenshotDataUrl must be a PNG, JPEG, or WebP data URL');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) throw new CaptureValidationError('Screenshot exceeds 8 MB');
    screenshot = { mimeType: match[1] as 'image/png' | 'image/jpeg' | 'image/webp', bytes };
  }
  const element = body.element && typeof body.element === 'object' ? body.element as Record<string, unknown> : undefined;
  const reproduction = body.reproduction && typeof body.reproduction === 'object' ? body.reproduction as Record<string, unknown> : undefined;
  const rawEvents = reproduction?.events;
  const events = Array.isArray(rawEvents) ? rawEvents.slice(0, MAX_EVENTS).map((event) => {
    const item = event && typeof event === 'object' ? event as Record<string, unknown> : {};
    const type = item.type;
    if (type !== 'click' && type !== 'scroll' && type !== 'input') throw new CaptureValidationError('Invalid reproduction event type');
    return {
      type,
      at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
      x: typeof item.x === 'number' ? item.x : undefined,
      y: typeof item.y === 'number' ? item.y : undefined,
      target: boundedString(item.target, 'event.target', 300),
      // Input values are intentionally discarded. Only length is accepted.
      valueLength: type === 'input' && typeof item.valueLength === 'number' ? Math.max(0, Math.min(10_000, Math.floor(item.valueLength))) : undefined,
    } as CaptureEvent;
  }) : [];
  return {
    projectId: boundedString(body.projectId, 'projectId', 200, true)!,
    title: boundedString(body.title, 'title', 300, true)!,
    url: validateUrl(body.url, 'url'),
    screenshot,
    selectedText: boundedString(body.selectedText, 'selectedText', MAX_TEXT_LENGTH),
    selectedSource: body.selectedSource ? validateUrl(body.selectedSource, 'selectedSource') : undefined,
    element: element ? {
      selector: boundedString(element.selector, 'element.selector', 500),
      tagName: boundedString(element.tagName, 'element.tagName', 50),
      text: boundedString(element.text, 'element.text', 2_000),
    } : undefined,
    expectedBehavior: boundedString(body.expectedBehavior, 'expectedBehavior', MAX_TEXT_LENGTH),
    reproduction: reproduction ? {
      events,
      startedAt: typeof reproduction.startedAt === 'number' ? reproduction.startedAt : undefined,
      stoppedAt: typeof reproduction.stoppedAt === 'number' ? reproduction.stoppedAt : undefined,
    } : undefined,
  };
}

export async function storeCaptureScreenshot(screenshot: NonNullable<ValidatedBrowserCapture['screenshot']>): Promise<{ filename: string; path: string; mimeType: string }> {
  const directory = getGlobalImageAssetsDir();
  await fs.mkdir(directory, { recursive: true });
  const extension = ALLOWED_IMAGE_TYPES.get(screenshot.mimeType);
  if (!extension) throw new CaptureValidationError('Unsupported screenshot type');
  const filename = `browser-capture-${randomUUID()}.${extension}`;
  const absolutePath = path.join(directory, filename);
  await fs.writeFile(absolutePath, screenshot.bytes, { flag: 'wx', mode: 0o600 });
  return { filename, path: toPosixPath(absolutePath), mimeType: screenshot.mimeType };
}

export function buildCaptureDescription(capture: ValidatedBrowserCapture, evidence?: { filename: string }): string {
  const lines = [`Captured from: ${capture.url}`];
  if (capture.element) lines.push(`Selected element: ${capture.element.tagName || 'element'}${capture.element.selector ? ` (${capture.element.selector})` : ''}${capture.element.text ? `\n${capture.element.text}` : ''}`);
  if (capture.selectedText) lines.push(`Selected text:\n${capture.selectedText}${capture.selectedSource ? `\nSource: ${capture.selectedSource}` : ''}`);
  if (capture.expectedBehavior) lines.push(`Expected behavior:\n${capture.expectedBehavior}`);
  if (capture.reproduction?.events?.length) lines.push(`Reproduction events (${capture.reproduction.events.length}):\n${JSON.stringify(capture.reproduction.events)}`);
  if (evidence) lines.push(`Evidence screenshot: /api/assets/images/${evidence.filename}`);
  return lines.join('\n\n');
}
