import { Buffer } from 'node:buffer';

export const DEFAULT_NETWORK_MAX_ENTRIES = 500;
export const DEFAULT_NETWORK_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_NETWORK_MAX_BODY_BYTES_PER_REQUEST = 512 * 1024;

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
]);

const TEXT_MIME_TYPES = [
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/x-javascript',
  'application/x-www-form-urlencoded',
  'application/xml',
  'image/svg+xml',
  'text/',
];

export type NetworkBody = {
  size: number;
  capturedBytes: number;
  mimeType?: string;
  text?: string;
  base64?: string;
  encoding?: 'base64';
  truncated: boolean;
};

export type NetworkTiming = {
  blockedMs?: number;
  dnsMs?: number;
  connectMs?: number;
  sslMs?: number;
  requestMs?: number;
  ttfbMs?: number;
  receiveMs?: number;
  durationMs?: number;
};

export type CapturedNetworkRequest = {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  startedAt: string;
  startedAtMs: number;
  finishedAt?: string;
  status?: number;
  statusText?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: NetworkBody;
  responseBody?: NetworkBody;
  requestBodySize?: number;
  responseBodySize?: number;
  transferSize?: number;
  mimeType?: string;
  protocol?: string;
  timing: NetworkTiming;
  failed?: boolean;
  failureText?: string;
  aborted?: boolean;
  pageUrl?: string;
};

export type NetworkRequestSummary = {
  id: string;
  method: string;
  url: string;
  status: number | null;
  type: string;
  size: number;
  duration: number | null;
  failed: boolean;
  startedAt: string;
};

export type NetworkFilter = {
  url?: string;
  urlRegex?: string | RegExp;
  method?: string;
  status?: number | number[];
  resourceType?: string;
  minDurationMs?: number;
  since?: string | number;
};

export type NetworkAnalysis = {
  totalRequests: number;
  totalBytes: number;
  failedCount: number;
  slowestRequests: NetworkRequestSummary[];
  failedRequests: NetworkRequestSummary[];
  largestPayloads: NetworkRequestSummary[];
  duplicateRequests: Array<{
    method: string;
    url: string;
    count: number;
    requestIds: string[];
    totalBytes: number;
  }>;
  domains: Array<{
    domain: string;
    requests: number;
    bytes: number;
    failed: number;
  }>;
  blockingRequests: NetworkRequestSummary[];
  longTtfbRequests: NetworkRequestSummary[];
  findings: string[];
};

export type NetworkCaptureOptions = {
  enabled?: boolean;
  maxEntries?: number;
  maxBodyBytes?: number;
  maxBodyBytesPerRequest?: number;
};

type PageBinding = {
  page: any;
  request: (request: any) => void;
  response: (response: any) => void;
  finished: (request: any) => void;
  failed: (request: any) => void;
};

type ContextBinding = {
  context: any;
  page: (page: any) => void;
};

type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  detach?: () => Promise<void>;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function numberFromHeader(headers: Record<string, string>, name: string): number | undefined {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  if (Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.name === 'string') {
        result[record.name] = String(record.value ?? '');
      }
    }
    return result;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? '')]),
  );
}

export function redactHeaders(
  headers: Record<string, string> | undefined,
  includeSensitive = false,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    includeSensitive || !SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? value : '[REDACTED]',
  ]));
}

function isTextBody(mimeType: string | undefined, bytes: Buffer): boolean {
  const normalizedMimeType = (mimeType || '').toLowerCase();
  if (TEXT_MIME_TYPES.some((prefix) => normalizedMimeType.startsWith(prefix))) {
    return true;
  }

  // A NUL byte is a useful conservative signal for images, archives, and other
  // binary responses whose server omitted Content-Type.
  if (bytes.includes(0)) {
    return false;
  }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !/[\u0000-\u0008\u000e-\u001f]/.test(decoded);
  } catch {
    return false;
  }
}

function bodyFromBytes(
  bytes: Buffer,
  originalSize: number,
  mimeType: string | undefined,
  truncated: boolean,
): NetworkBody {
  if (isTextBody(mimeType, bytes)) {
    return {
      size: originalSize,
      capturedBytes: bytes.length,
      mimeType,
      text: bytes.toString('utf8'),
      truncated,
    };
  }

  return {
    size: originalSize,
    capturedBytes: bytes.length,
    mimeType,
    base64: bytes.toString('base64'),
    encoding: 'base64',
    truncated,
  };
}

function cloneBody(body: NetworkBody | undefined): NetworkBody | undefined {
  return body ? { ...body } : undefined;
}

function cloneRequest(request: CapturedNetworkRequest): CapturedNetworkRequest {
  return {
    ...request,
    requestHeaders: { ...request.requestHeaders },
    responseHeaders: { ...request.responseHeaders },
    requestBody: cloneBody(request.requestBody),
    responseBody: cloneBody(request.responseBody),
    timing: { ...request.timing },
  };
}

function responseSize(request: CapturedNetworkRequest): number {
  return request.responseBodySize
    ?? request.responseBody?.size
    ?? request.transferSize
    ?? 0;
}

function requestDuration(request: CapturedNetworkRequest): number | null {
  const duration = request.timing.durationMs;
  return duration !== undefined && Number.isFinite(duration) ? Math.max(0, duration) : null;
}

export function summarizeNetworkRequest(request: CapturedNetworkRequest): NetworkRequestSummary {
  return {
    id: request.id,
    method: request.method,
    url: request.url,
    status: request.status ?? null,
    type: request.resourceType || 'other',
    size: responseSize(request),
    duration: requestDuration(request),
    failed: Boolean(request.failed || request.aborted || (request.status !== undefined && request.status >= 400)),
    startedAt: request.startedAt,
  };
}

function parseSince(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid since timestamp "${value}".`);
    }
    return parsed;
  }
  return undefined;
}

export function filterNetworkRequests(
  requests: CapturedNetworkRequest[],
  filter: NetworkFilter = {},
): CapturedNetworkRequest[] {
  let urlRegex: RegExp | undefined;
  if (filter.urlRegex instanceof RegExp) {
    urlRegex = filter.urlRegex;
  } else if (typeof filter.urlRegex === 'string' && filter.urlRegex.trim()) {
    try {
      urlRegex = new RegExp(filter.urlRegex);
    } catch (error) {
      throw new Error(`Invalid urlRegex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const method = filter.method?.trim().toUpperCase();
  const resourceType = filter.resourceType?.trim().toLowerCase();
  const minDurationMs = finiteNumber(filter.minDurationMs);
  const since = parseSince(filter.since);
  const statuses = Array.isArray(filter.status)
    ? new Set(filter.status.filter((value) => Number.isFinite(value)))
    : filter.status === undefined
      ? null
      : new Set([filter.status]);

  return requests.filter((request) => {
    if (filter.url && !request.url.toLowerCase().includes(filter.url.toLowerCase())) {
      return false;
    }
    if (urlRegex) {
      urlRegex.lastIndex = 0;
      if (!urlRegex.test(request.url)) {
        return false;
      }
    }
    if (method && request.method.toUpperCase() !== method) {
      return false;
    }
    if (statuses && !statuses.has(request.status ?? -1)) {
      return false;
    }
    if (resourceType && request.resourceType.toLowerCase() !== resourceType) {
      return false;
    }
    const duration = requestDuration(request);
    if (minDurationMs !== undefined && (duration === null || duration < minDurationMs)) {
      return false;
    }
    if (since !== undefined && request.startedAtMs < since) {
      return false;
    }
    return true;
  });
}

function serializeBody(body: NetworkBody | undefined, maxBodyBytes: number): Record<string, unknown> | null {
  if (!body) {
    return null;
  }

  const limit = Math.max(0, Math.floor(maxBodyBytes));
  const capturedBytes = body.encoding === 'base64' && body.base64
    ? Buffer.from(body.base64, 'base64')
    : Buffer.from(body.text || '', 'utf8');
  const outputBytes = capturedBytes.subarray(0, Math.min(limit, capturedBytes.length));
  const truncated = body.truncated || outputBytes.length < capturedBytes.length || outputBytes.length < body.size;
  const result: Record<string, unknown> = {
    size: body.size,
    capturedBytes: outputBytes.length,
    mimeType: body.mimeType,
    truncated,
    omittedBytes: Math.max(0, body.size - outputBytes.length),
  };

  if (body.encoding === 'base64') {
    result.encoding = 'base64';
    result.base64 = outputBytes.toString('base64');
  } else {
    result.text = outputBytes.toString('utf8');
  }
  return result;
}

export function serializeNetworkRequest(
  request: CapturedNetworkRequest,
  options: { includeSensitive?: boolean; maxBodyBytes?: number } = {},
): Record<string, unknown> {
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes)
    ? Math.max(0, Math.floor(options.maxBodyBytes as number))
    : DEFAULT_NETWORK_MAX_BODY_BYTES_PER_REQUEST;
  return {
    id: request.id,
    method: request.method,
    url: request.url,
    resourceType: request.resourceType,
    startedAt: request.startedAt,
    finishedAt: request.finishedAt || null,
    status: request.status ?? null,
    statusText: request.statusText || null,
    requestHeaders: redactHeaders(request.requestHeaders, options.includeSensitive === true),
    responseHeaders: redactHeaders(request.responseHeaders, options.includeSensitive === true),
    requestBody: serializeBody(request.requestBody, maxBodyBytes),
    responseBody: serializeBody(request.responseBody, maxBodyBytes),
    requestBodySize: request.requestBodySize ?? request.requestBody?.size ?? 0,
    responseBodySize: responseSize(request),
    transferSize: request.transferSize ?? null,
    mimeType: request.mimeType || null,
    protocol: request.protocol || null,
    timing: { ...request.timing },
    failed: Boolean(request.failed || request.aborted || (request.status !== undefined && request.status >= 400)),
    aborted: Boolean(request.aborted),
    failureText: request.failureText || null,
    pageUrl: request.pageUrl || null,
  };
}

function headerEntries(headers: Record<string, string>, includeSensitive: boolean) {
  return Object.entries(redactHeaders(headers, includeSensitive)).map(([name, value]) => ({ name, value }));
}

function queryStringForUrl(rawUrl: string) {
  try {
    return [...new URL(rawUrl).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function harBody(body: NetworkBody | undefined): Record<string, unknown> | undefined {
  if (!body) {
    return undefined;
  }
  const result: Record<string, unknown> = {
    size: body.size,
    mimeType: body.mimeType || 'application/octet-stream',
  };
  if (body.encoding === 'base64') {
    result.text = body.base64 || '';
    result.encoding = 'base64';
  } else {
    result.text = body.text || '';
  }
  if (body.truncated) {
    result.comment = 'Body truncated by the bounded CloudCLI network capture.';
  }
  return result;
}

/**
 * HAR 1.2 requires `time` to equal the sum of the reported timing values.
 * Playwright can report a partial timing shape, so preserve known values in
 * order while allocating the remaining duration to the first available
 * fallback. Values are clamped to avoid emitting an invalid over-specified
 * entry when a driver reports inconsistent timestamps.
 */
function harTimings(timing: NetworkTiming, duration: number): Record<string, number> {
  const values: Array<[string, number | undefined]> = [
    ['blocked', timing.blockedMs],
    ['dns', timing.dnsMs],
    ['connect', timing.connectMs],
    ['send', timing.requestMs],
    ['wait', timing.ttfbMs],
    ['receive', timing.receiveMs],
    ['ssl', timing.sslMs],
  ];
  let remaining = Math.max(0, duration);
  let hasKnownValue = false;
  const result: Record<string, number> = {};
  for (const [name, rawValue] of values) {
    if (rawValue === undefined) {
      result[name] = -1;
      continue;
    }
    hasKnownValue = true;
    const value = Math.min(remaining, Math.max(0, rawValue));
    result[name] = value;
    remaining -= value;
  }
  if (!hasKnownValue) {
    result.wait = Math.max(0, duration);
    return result;
  }
  if (remaining > 0) {
    const fallback = values.find(([name, rawValue]) => rawValue === undefined && name === 'receive')?.[0]
      || values.find(([name, rawValue]) => rawValue === undefined && name !== 'ssl')?.[0]
      || 'receive';
    result[fallback] = (result[fallback] >= 0 ? result[fallback] : 0) + remaining;
  }
  return result;
}

export function assembleHar(
  requests: CapturedNetworkRequest[],
  options: { includeSensitive?: boolean; creatorVersion?: string } = {},
) {
  const includeSensitive = options.includeSensitive === true;
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'cloudcli-browser',
        version: options.creatorVersion || '1.0.0',
      },
      entries: requests.map((request) => {
        const duration = requestDuration(request) ?? 0;
        const timing = request.timing;
        const requestBody = harBody(request.requestBody);
        const responseBody = harBody(request.responseBody);
        const responseSizeValue = responseSize(request);

        return {
          startedDateTime: request.startedAt,
          time: duration,
          request: {
            method: request.method,
            url: request.url,
            httpVersion: request.protocol || 'HTTP/1.1',
            headers: headerEntries(request.requestHeaders, includeSensitive),
            queryString: queryStringForUrl(request.url),
            cookies: [],
            headersSize: -1,
            bodySize: request.requestBodySize ?? requestBody?.size ?? 0,
            ...(requestBody ? { postData: requestBody } : {}),
          },
          response: {
            status: request.status ?? 0,
            statusText: request.statusText || '',
            httpVersion: request.protocol || 'HTTP/1.1',
            headers: headerEntries(request.responseHeaders, includeSensitive),
            cookies: [],
            headersSize: -1,
            bodySize: responseSizeValue,
            content: responseBody || {
              size: responseSizeValue,
              mimeType: request.mimeType || 'application/octet-stream',
            },
            redirectURL: '',
          },
          cache: {},
          timings: harTimings(timing, duration),
          _cloudcli: {
            id: request.id,
            resourceType: request.resourceType,
            failed: Boolean(request.failed),
            aborted: Boolean(request.aborted),
            failureText: request.failureText || undefined,
            transferSize: request.transferSize,
            pageUrl: request.pageUrl,
          },
        };
      }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseHarBody(
  value: unknown,
  fallbackSize: number | undefined,
  mimeType: string | undefined,
  entryIndex: number,
  label: string,
): NetworkBody | undefined {
  const record = asRecord(value);
  if (!record) {
    return fallbackSize !== undefined ? {
      size: fallbackSize,
      capturedBytes: 0,
      mimeType,
      truncated: true,
    } : undefined;
  }

  const rawText = typeof record.text === 'string' ? record.text : '';
  const declaredSize = nonNegativeNumber(record.size) ?? fallbackSize ?? rawText.length;
  if (record.encoding === 'base64') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(rawText)) {
      throw new Error(`Invalid HAR entry ${entryIndex} ${label} body: invalid base64 text.`);
    }
    try {
      const bytes = Buffer.from(rawText, 'base64');
      return {
        size: declaredSize,
        capturedBytes: bytes.length,
        mimeType,
        base64: bytes.toString('base64'),
        encoding: 'base64',
        truncated: bytes.length < declaredSize,
      };
    } catch (error) {
      throw new Error(`Invalid HAR entry ${entryIndex} ${label} body: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    size: declaredSize,
    capturedBytes: Buffer.byteLength(rawText),
    mimeType,
    text: rawText,
    truncated: Buffer.byteLength(rawText) < declaredSize,
  };
}

function parseHarTiming(value: unknown, entryTime: number | undefined): NetworkTiming {
  const timings = asRecord(value) || {};
  const blockedMs = nonNegativeNumber(timings.blocked);
  const dnsMs = nonNegativeNumber(timings.dns);
  const connectMs = nonNegativeNumber(timings.connect);
  const sslMs = nonNegativeNumber(timings.ssl);
  const requestMs = nonNegativeNumber(timings.send);
  const ttfbMs = nonNegativeNumber(timings.wait);
  const receiveMs = nonNegativeNumber(timings.receive);
  const durationMs = nonNegativeNumber(entryTime);
    
  return {
    ...(blockedMs !== undefined ? { blockedMs } : {}),
    ...(dnsMs !== undefined ? { dnsMs } : {}),
    ...(connectMs !== undefined ? { connectMs } : {}),
    ...(sslMs !== undefined ? { sslMs } : {}),
    ...(requestMs !== undefined ? { requestMs } : {}),
    ...(ttfbMs !== undefined ? { ttfbMs } : {}),
    ...(receiveMs !== undefined ? { receiveMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function parseStartedAt(value: unknown, entryIndex: number): { iso: string; ms: number } {
  if (value === undefined || value === null || value === '') {
    return { iso: new Date(0).toISOString(), ms: 0 };
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid HAR entry ${entryIndex}: startedDateTime must be an ISO string.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid HAR entry ${entryIndex}: startedDateTime is not a valid date.`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

function harFailure(entry: Record<string, unknown>): { failed: boolean; aborted: boolean; failureText?: string } {
  const metadata = asRecord(entry._cloudcli);
  const response = asRecord(entry.response);
  const status = finiteNumber(response?.status);
  const failureText = typeof metadata?.failureText === 'string' ? metadata.failureText : undefined;
  const aborted = metadata?.aborted === true || /abort|cancel/i.test(failureText || '');
  const failed = metadata?.failed === true || aborted || (status !== undefined && status >= 400);
  return { failed, aborted, ...(failureText ? { failureText } : {}) };
}

export function parseHar(input: unknown): CapturedNetworkRequest[] {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch (error) {
      throw new Error(`Invalid HAR JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const root = asRecord(parsed);
  const log = asRecord(root?.log);
  if (!log) {
    throw new Error('Invalid HAR: expected a top-level log object.');
  }
  if (log.entries !== undefined && !Array.isArray(log.entries)) {
    throw new Error('Invalid HAR: log.entries must be an array.');
  }
  if (!Array.isArray(log.entries)) {
    throw new Error('Invalid HAR: log.entries is required.');
  }

  return log.entries.map((rawEntry, entryIndex) => {
    const entry = asRecord(rawEntry);
    if (!entry) {
      throw new Error(`Invalid HAR entry ${entryIndex}: expected an object.`);
    }
    const request = asRecord(entry.request);
    if (!request || typeof request.url !== 'string' || !request.url.trim()) {
      throw new Error(`Invalid HAR entry ${entryIndex}: request.url is required.`);
    }
    const response = asRecord(entry.response) || {};
    const requestHeaders = normalizeHeaders(request.headers);
    const responseHeaders = normalizeHeaders(response.headers);
    const started = parseStartedAt(entry.startedDateTime, entryIndex);
    const status = finiteNumber(response.status);
    const statusText = typeof response.statusText === 'string' ? response.statusText : undefined;
    const responseContent = asRecord(response.content);
    const requestPostData = asRecord(request.postData);
    const responseSizeValue = nonNegativeNumber(response.bodySize)
      ?? nonNegativeNumber(responseContent?.size);
    const requestSizeValue = nonNegativeNumber(request.bodySize)
      ?? nonNegativeNumber(requestPostData?.size);
    const metadata = asRecord(entry._cloudcli);
    const failure = harFailure(entry);
    const bodyMimeType = typeof responseContent?.mimeType === 'string'
      ? responseContent.mimeType
      : Object.entries(responseHeaders).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    const responseBody = parseHarBody(
      responseContent,
      responseSizeValue,
      bodyMimeType,
      entryIndex,
      'response',
    );
    const requestBody = parseHarBody(
      requestPostData,
      requestSizeValue,
      typeof requestPostData?.mimeType === 'string' ? requestPostData.mimeType : undefined,
      entryIndex,
      'request',
    );
    const entryTime = nonNegativeNumber(entry.time);
    const timing = parseHarTiming(entry.timings, entryTime);
    const resourceType = typeof metadata?.resourceType === 'string' ? metadata.resourceType : 'other';
    const transferSize = nonNegativeNumber(metadata?.transferSize)
      ?? responseSizeValue
      ?? responseBody?.size;

    return {
      id: typeof metadata?.id === 'string' && metadata.id ? metadata.id : `har-${entryIndex + 1}`,
      url: request.url,
      method: typeof request.method === 'string' && request.method ? request.method.toUpperCase() : 'GET',
      resourceType,
      startedAt: started.iso,
      startedAtMs: started.ms,
      finishedAt: entryTime !== undefined ? new Date(started.ms + entryTime).toISOString() : undefined,
      ...(status !== undefined ? { status } : {}),
      ...(statusText ? { statusText } : {}),
      requestHeaders,
      responseHeaders,
      ...(requestBody ? { requestBody } : {}),
      ...(responseBody ? { responseBody } : {}),
      ...(requestSizeValue !== undefined ? { requestBodySize: requestSizeValue } : {}),
      ...(responseSizeValue !== undefined ? { responseBodySize: responseSizeValue } : {}),
      ...(transferSize !== undefined ? { transferSize } : {}),
      ...(bodyMimeType ? { mimeType: bodyMimeType } : {}),
      ...(typeof request.httpVersion === 'string' ? { protocol: request.httpVersion } : {}),
      timing,
      ...(failure.failed ? { failed: true } : {}),
      ...(failure.aborted ? { aborted: true } : {}),
      ...(failure.failureText ? { failureText: failure.failureText } : {}),
      ...(typeof metadata?.pageUrl === 'string' ? { pageUrl: metadata.pageUrl } : {}),
    };
  });
}

function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname || '(unknown)';
  } catch {
    return '(invalid-url)';
  }
}

export function analyzeNetworkRequests(
  requests: CapturedNetworkRequest[],
  options: { topN?: number; filter?: NetworkFilter } = {},
): NetworkAnalysis {
  const filtered = filterNetworkRequests(requests, options.filter || {});
  const topN = Math.max(1, Math.min(100, Math.floor(options.topN ?? 10)));
  const summaries = filtered.map(summarizeNetworkRequest);
  const byDuration = [...summaries].sort((left, right) => (right.duration ?? 0) - (left.duration ?? 0));
  const bySize = [...summaries].sort((left, right) => right.size - left.size);
  const failedRequests = summaries.filter((request) => request.failed || (request.status !== null && request.status >= 400));
  const blockingRequests = filtered
    .filter((request) => (request.timing.blockedMs ?? 0) >= 200)
    .sort((left, right) => (right.timing.blockedMs ?? 0) - (left.timing.blockedMs ?? 0))
    .map(summarizeNetworkRequest)
    .slice(0, topN);
  const longTtfbRequests = filtered
    .filter((request) => (request.timing.ttfbMs ?? 0) >= 500)
    .sort((left, right) => (right.timing.ttfbMs ?? 0) - (left.timing.ttfbMs ?? 0))
    .map(summarizeNetworkRequest)
    .slice(0, topN);

  const duplicateMap = new Map<string, CapturedNetworkRequest[]>();
  for (const request of filtered) {
    const key = `${request.method.toUpperCase()} ${request.url}`;
    const group = duplicateMap.get(key) || [];
    group.push(request);
    duplicateMap.set(key, group);
  }
  const duplicateRequests = [...duplicateMap.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const firstSpace = key.indexOf(' ');
      return {
        method: key.slice(0, firstSpace),
        url: key.slice(firstSpace + 1),
        count: group.length,
        requestIds: group.map((request) => request.id),
        totalBytes: group.reduce((sum, request) => sum + responseSize(request), 0),
      };
    })
    .sort((left, right) => right.count - left.count || right.totalBytes - left.totalBytes);

  const domainMap = new Map<string, { requests: number; bytes: number; failed: number }>();
  for (const request of filtered) {
    const domain = domainForUrl(request.url);
    const current = domainMap.get(domain) || { requests: 0, bytes: 0, failed: 0 };
    current.requests += 1;
    current.bytes += responseSize(request);
    if (request.failed || (request.status !== undefined && request.status >= 400)) {
      current.failed += 1;
    }
    domainMap.set(domain, current);
  }
  const domains = [...domainMap.entries()]
    .map(([domain, value]) => ({ domain, ...value }))
    .sort((left, right) => right.bytes - left.bytes || right.requests - left.requests);

  const findings: string[] = [];
  const uncompressedLarge = filtered.filter((request) => responseSize(request) > 1024 * 1024
    && !Object.keys(request.responseHeaders).some((name) => name.toLowerCase() === 'content-encoding'));
  if (uncompressedLarge.length) {
    findings.push(`uncompressed >1MB response (${uncompressedLarge.length})`);
  }
  const notFoundCount = filtered.filter((request) => request.status === 404).length;
  if (notFoundCount) {
    findings.push(`404s (${notFoundCount})`);
  }
  const serverErrorCount = filtered.filter((request) => request.status !== undefined && request.status >= 500).length;
  if (serverErrorCount) {
    findings.push(`5xx responses (${serverErrorCount})`);
  }
  if (duplicateRequests.length) {
    findings.push(`duplicate requests (${duplicateRequests.length} URL groups)`);
  }
  if (blockingRequests.length) {
    findings.push(`blocking requests (${blockingRequests.length})`);
  }
  if (longTtfbRequests.length) {
    findings.push(`long TTFB (${longTtfbRequests.length})`);
  }

  const ordered = [...filtered].sort((left, right) => left.startedAtMs - right.startedAtMs);
  let chainLength = ordered.length ? 1 : 0;
  let longestChain = chainLength;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const previousEnd = previous.startedAtMs + (requestDuration(previous) ?? 0);
    if (current.startedAtMs >= previousEnd && current.startedAtMs - previousEnd <= 250) {
      chainLength += 1;
    } else {
      chainLength = 1;
    }
    longestChain = Math.max(longestChain, chainLength);
  }
  if (longestChain >= 3) {
    findings.push(`sequential chains (${longestChain} requests)`);
  }
  if (failedRequests.length && !findings.some((finding) => finding.startsWith('404s') || finding.startsWith('5xx'))) {
    findings.push(`failed requests (${failedRequests.length})`);
  }

  return {
    totalRequests: filtered.length,
    totalBytes: filtered.reduce((sum, request) => sum + responseSize(request), 0),
    failedCount: failedRequests.length,
    slowestRequests: byDuration.slice(0, topN),
    failedRequests,
    largestPayloads: bySize.slice(0, topN),
    duplicateRequests,
    domains,
    blockingRequests,
    longTtfbRequests,
    findings,
  };
}

function readTimingValue(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric >= 0 ? numeric : undefined;
}

function timingFromPlaywright(value: unknown, startedAtMs: number, finishedAtMs: number): NetworkTiming {
  const raw = asRecord(value) || {};
  const requestStart = readTimingValue(raw.requestStart);
  const requestEnd = readTimingValue(raw.requestEnd) ?? requestStart;
  const responseStart = readTimingValue(raw.responseStart);
  const responseEnd = readTimingValue(raw.responseEnd);
  const difference = (end: number | undefined, start: number | undefined) => (
    end !== undefined && start !== undefined && end >= start ? end - start : undefined
  );
  const timing: NetworkTiming = {
    // Playwright's startTime is epoch milliseconds; the remaining fields are
    // milliseconds relative to that start and must not be compared to it.
    blockedMs: requestStart,
    dnsMs: difference(readTimingValue(raw.domainLookupEnd), readTimingValue(raw.domainLookupStart)),
    connectMs: difference(readTimingValue(raw.connectEnd), readTimingValue(raw.connectStart)),
    sslMs: difference(readTimingValue(raw.connectEnd), readTimingValue(raw.secureConnectionStart)),
    requestMs: difference(requestEnd, requestStart),
    ttfbMs: difference(responseStart, requestEnd),
    receiveMs: difference(responseEnd, responseStart),
    durationMs: responseEnd,
  };
  if (timing.durationMs === undefined) {
    timing.durationMs = Math.max(0, finishedAtMs - startedAtMs);
  }
  return Object.fromEntries(Object.entries(timing).filter(([, value]) => value !== undefined)) as NetworkTiming;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class NetworkCapture {
  private readonly sessionId: string;
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;
  private readonly maxBodyBytesPerRequest: number;
  private readonly entries: CapturedNetworkRequest[] = [];
  private readonly pending = new Map<any, CapturedNetworkRequest>();
  private readonly bindings = new Map<any, PageBinding>();
  private readonly contextBindings = new Map<any, ContextBinding>();
  private readonly cdpSessions = new Map<any, CdpSession>();
  private bodyBytes = 0;
  private nextRequestId = 1;

  constructor(sessionId: string, options: NetworkCaptureOptions = {}) {
    this.sessionId = sessionId;
    this.enabled = options.enabled !== false;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? envNumber('CLOUDCLI_BROWSER_USE_NETWORK_MAX_ENTRIES', DEFAULT_NETWORK_MAX_ENTRIES)));
    this.maxBodyBytes = Math.max(0, Math.floor(options.maxBodyBytes ?? envNumber('CLOUDCLI_BROWSER_USE_NETWORK_MAX_BODY_BYTES', DEFAULT_NETWORK_MAX_BODY_BYTES)));
    this.maxBodyBytesPerRequest = Math.max(0, Math.floor(options.maxBodyBytesPerRequest ?? envNumber('CLOUDCLI_BROWSER_USE_NETWORK_MAX_BODY_BYTES_PER_REQUEST', DEFAULT_NETWORK_MAX_BODY_BYTES_PER_REQUEST)));
  }

  get recordingEnabled(): boolean {
    return this.enabled;
  }

  get stats() {
    return {
      entries: this.entries.length,
      bodyBytes: this.bodyBytes,
      maxEntries: this.maxEntries,
      maxBodyBytes: this.maxBodyBytes,
      recordingEnabled: this.enabled,
    };
  }

  getEntries(): CapturedNetworkRequest[] {
    return this.entries.map(cloneRequest);
  }

  clear(): { cleared: number } {
    const cleared = this.entries.length;
    this.entries.length = 0;
    this.pending.clear();
    this.bodyBytes = 0;
    return { cleared };
  }

  private addEntry(entry: CapturedNetworkRequest): void {
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift();
      if (removed?.requestBody) {
        this.bodyBytes -= removed.requestBody.capturedBytes;
      }
      if (removed?.responseBody) {
        this.bodyBytes -= removed.responseBody.capturedBytes;
      }
      for (const [request, pendingEntry] of this.pending.entries()) {
        if (pendingEntry === removed) {
          this.pending.delete(request);
        }
      }
      this.bodyBytes = Math.max(0, this.bodyBytes);
    }
  }

  private captureBody(
    entry: CapturedNetworkRequest,
    target: 'requestBody' | 'responseBody',
    rawBody: Buffer,
    mimeType?: string,
    declaredSize?: number,
  ): void {
    if (!this.entries.includes(entry)) {
      return;
    }
    const originalSize = Math.max(rawBody.length, declaredSize ?? 0);
    const available = Math.max(0, this.maxBodyBytes - this.bodyBytes);
    const limit = Math.min(this.maxBodyBytesPerRequest, available);
    const bytes = rawBody.subarray(0, limit);
    const body = bodyFromBytes(bytes, originalSize, mimeType, bytes.length < originalSize);
    const previous = entry[target];
    if (previous) {
      this.bodyBytes -= previous.capturedBytes;
    }
    entry[target] = body;
    this.bodyBytes += body.capturedBytes;
  }

  private setBodyMarker(
    entry: CapturedNetworkRequest,
    target: 'requestBody' | 'responseBody',
    size: number,
    mimeType?: string,
  ): void {
    if (size <= 0 || !this.entries.includes(entry)) {
      return;
    }
    const previous = entry[target];
    if (previous) {
      this.bodyBytes -= previous.capturedBytes;
    }
    entry[target] = {
      size,
      capturedBytes: 0,
      mimeType,
      truncated: true,
    };
  }

  private async requestHeaders(request: any): Promise<Record<string, string>> {
    try {
      if (typeof request.allHeaders === 'function') {
        return normalizeHeaders(await request.allHeaders());
      }
      return normalizeHeaders(request.headers?.());
    } catch {
      return {};
    }
  }

  private async responseHeaders(response: any): Promise<Record<string, string>> {
    try {
      if (typeof response.allHeaders === 'function') {
        return normalizeHeaders(await response.allHeaders());
      }
      return normalizeHeaders(response.headers?.());
    } catch {
      return {};
    }
  }

  private getEntryForRequest(request: any, page?: any): CapturedNetworkRequest {
    const existing = this.pending.get(request);
    if (existing) {
      return existing;
    }
    const startedAtMs = Date.now();
    const entry: CapturedNetworkRequest = {
      id: `${this.sessionId}:network-${this.nextRequestId++}`,
      url: String(request?.url?.() || ''),
      method: String(request?.method?.() || 'GET').toUpperCase(),
      resourceType: String(request?.resourceType?.() || 'other'),
      startedAt: nowIso(),
      startedAtMs,
      requestHeaders: {},
      responseHeaders: {},
      timing: {},
      pageUrl: page?.url?.() || undefined,
    };
    this.pending.set(request, entry);
    this.addEntry(entry);
    return entry;
  }

  private async onRequest(page: any, request: any): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const entry = this.getEntryForRequest(request, page);
    entry.requestHeaders = await this.requestHeaders(request);
    const postDataBuffer = (() => {
      try {
        return typeof request.postDataBuffer === 'function' ? request.postDataBuffer() : null;
      } catch {
        return null;
      }
    })();
    if (postDataBuffer) {
      const body = Buffer.from(postDataBuffer);
      entry.requestBodySize = body.length;
      if (body.length <= this.maxBodyBytesPerRequest && body.length <= this.maxBodyBytes) {
        this.captureBody(entry, 'requestBody', body, undefined, body.length);
      } else {
        this.setBodyMarker(entry, 'requestBody', body.length);
      }
    }
  }

  private async onResponse(page: any, response: any): Promise<void> {
    if (!this.enabled) {
      return;
    }
    let request: any;
    try {
      request = response.request?.();
    } catch {
      request = undefined;
    }
    const entry = this.getEntryForRequest(request || response, page);
    entry.status = finiteNumber(response.status?.());
    entry.statusText = typeof response.statusText === 'function' ? String(response.statusText() || '') : undefined;
    entry.responseHeaders = await this.responseHeaders(response);
    entry.mimeType = Object.entries(entry.responseHeaders)
      .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
      ?.split(';')[0]
      ?.trim();
    entry.responseBodySize = numberFromHeader(entry.responseHeaders, 'content-length');
    const timing = (() => {
      try {
        return request?.timing?.();
      } catch {
        return undefined;
      }
    })();
    entry.timing = { ...entry.timing, ...timingFromPlaywright(timing, entry.startedAtMs, Date.now()) };
  }

  private async onFinished(request: any, page: any): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const entry = this.getEntryForRequest(request, page);
    const finishedAtMs = Date.now();
    entry.finishedAt = new Date(finishedAtMs).toISOString();
    let response: any;
    try {
      response = await request.response?.();
    } catch {
      response = undefined;
    }
    if (response) {
      const declaredSize = entry.responseBodySize ?? numberFromHeader(entry.responseHeaders, 'content-length');
      const mimeType = entry.mimeType;
      if (declaredSize !== undefined && declaredSize > this.maxBodyBytesPerRequest) {
        this.setBodyMarker(entry, 'responseBody', declaredSize, mimeType);
      } else {
        try {
          const rawBody = Buffer.from(await response.body());
          entry.responseBodySize = Math.max(entry.responseBodySize ?? 0, rawBody.length);
          this.captureBody(entry, 'responseBody', rawBody, mimeType, entry.responseBodySize);
        } catch {
          if (declaredSize !== undefined) {
            this.setBodyMarker(entry, 'responseBody', declaredSize, mimeType);
          }
        }
      }
    }
    const timing = (() => {
      try {
        return request.timing?.();
      } catch {
        return undefined;
      }
    })();
    entry.timing = {
      ...entry.timing,
      ...timingFromPlaywright(timing, entry.startedAtMs, finishedAtMs),
    };
    if (entry.responseBodySize === undefined && entry.responseBody) {
      entry.responseBodySize = entry.responseBody.size;
    }
    this.pending.delete(request);
  }

  private onFailed(request: any, page: any): void {
    if (!this.enabled) {
      return;
    }
    const entry = this.getEntryForRequest(request, page);
    const finishedAtMs = Date.now();
    entry.finishedAt = new Date(finishedAtMs).toISOString();
    entry.failed = true;
    try {
      entry.failureText = String(request.failure?.() || 'Network request failed');
    } catch {
      entry.failureText = 'Network request failed';
    }
    entry.aborted = /abort|cancel/i.test(entry.failureText);
    entry.timing.durationMs = Math.max(0, finishedAtMs - entry.startedAtMs);
    this.pending.delete(request);
  }

  async attachPage(page: any): Promise<void> {
    if (!page || this.bindings.has(page)) {
      return;
    }
    const binding: PageBinding = {
      page,
      request: (request) => { void this.onRequest(page, request); },
      response: (response) => { void this.onResponse(page, response); },
      finished: (request) => { void this.onFinished(request, page); },
      failed: (request) => { this.onFailed(request, page); },
    };
    this.bindings.set(page, binding);
    if (this.enabled) {
      page.on?.('request', binding.request);
      page.on?.('response', binding.response);
      page.on?.('requestfinished', binding.finished);
      page.on?.('requestfailed', binding.failed);
    }

    try {
      const context = page.context?.();
      const cdp = context?.newCDPSession ? await context.newCDPSession(page) : null;
      if (cdp) {
        this.cdpSessions.set(page, cdp as CdpSession);
        await cdp.send('Network.enable').catch(() => undefined);
      }
    } catch {
      // Firefox/WebKit and mocked drivers may not expose CDP. Page events still
      // provide useful capture data, and throttle reports unsupported below.
    }
  }

  attachContext(context: any): void {
    if (!context || this.contextBindings.has(context)) {
      return;
    }
    const binding: ContextBinding = {
      context,
      page: (page) => { void this.attachPage(page).catch(() => undefined); },
    };
    this.contextBindings.set(context, binding);
    context.on?.('page', binding.page);
  }

  async throttle(preset: 'offline' | 'slow-3g' | 'fast-3g' | 'none') {
    const presets = {
      offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
      'slow-3g': { offline: false, latency: 400, downloadThroughput: 62_500, uploadThroughput: 6_250 },
      'fast-3g': { offline: false, latency: 100, downloadThroughput: 187_500, uploadThroughput: 93_750 },
      none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    } as const;
    const conditions = presets[preset];
    if (!conditions) {
      throw new Error(`Unsupported network throttle preset "${preset}".`);
    }
    if (!this.cdpSessions.size) {
      throw new Error('Browser driver does not support CDP network throttling.');
    }
    let applied = 0;
    for (const cdp of this.cdpSessions.values()) {
      try {
        await cdp.send('Network.emulateNetworkConditions', conditions);
        applied += 1;
      } catch {
        // Continue so a closed tab does not prevent the remaining tabs from
        // receiving the requested conditions.
      }
    }
    if (!applied) {
      throw new Error('Unable to apply network throttle to the Browser session.');
    }
    return { preset, appliedToPages: applied, supported: true };
  }

  async dispose(): Promise<void> {
    for (const binding of this.contextBindings.values()) {
      binding.context.off?.('page', binding.page);
    }
    this.contextBindings.clear();
    for (const binding of this.bindings.values()) {
      if (this.enabled) {
        binding.page.off?.('request', binding.request);
        binding.page.off?.('response', binding.response);
        binding.page.off?.('requestfinished', binding.finished);
        binding.page.off?.('requestfailed', binding.failed);
      }
    }
    this.bindings.clear();
    await Promise.all([...this.cdpSessions.values()].map(async (cdp) => cdp.detach?.().catch(() => undefined)));
    this.cdpSessions.clear();
    this.pending.clear();
  }
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Descriptive aliases keep the pure helpers easy to discover for integrations
// and tests without changing the names used by the service.
export const buildHar = assembleHar;
export const filterCapturedRequests = filterNetworkRequests;
export const analyzeCapturedNetwork = analyzeNetworkRequests;
