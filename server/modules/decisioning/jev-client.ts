/**
 * Thin HTTP client for TypeSafe's System One endpoint.
 *
 * Deliberately dependency-free: the official SDK would pull a second HTTP
 * stack into the server for one POST, and Relay needs the transport to be
 * swappable anyway so tests and shadow-mode runs never touch the network.
 */

import type { JevRequest, JevResponse, JevTransport } from '@/modules/decisioning/jev.types.js';

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_SYSTEM_ONE_PATH = '/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';

/** Same env var the official SDK reads, so an existing shell export works. */
export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY';

const defaultTransport: JevTransport = async ({ url, apiKey, body, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`TypeSafe responded ${response.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as JevResponse;
  } finally {
    clearTimeout(timer);
  }
};

let transport: JevTransport = defaultTransport;

/** Test/bootstrap hook. Pass null to restore the real fetch transport. */
export function configureJevTransport(next: JevTransport | null): void {
  transport = next ?? defaultTransport;
}

export function jevSystemOneUrl(baseUrl: string): string {
  const trimmed = (baseUrl || JEV_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return `${trimmed || JEV_DEFAULT_BASE_URL}${JEV_SYSTEM_ONE_PATH}`;
}

export async function callJev(input: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  body: JevRequest;
}): Promise<JevResponse> {
  return transport({
    url: jevSystemOneUrl(input.baseUrl),
    apiKey: input.apiKey,
    body: input.body,
    timeoutMs: input.timeoutMs,
  });
}
