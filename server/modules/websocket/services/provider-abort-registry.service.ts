import type { LLMProvider } from '@/shared/types.js';

export type ProviderAbortFn = (sessionId: string) => Promise<boolean>;

/**
 * Provider-specific process-kill functions, configured once at server boot
 * from the same map handed to the chat websocket's `chat.abort` path
 * (server/index.js). Lets any module cancel a run's underlying provider
 * process by provider name alone, without duplicating server/index.js's
 * per-provider imports or requiring a websocket connection.
 */
let abortFns: Partial<Record<LLMProvider, ProviderAbortFn>> = {};

export function configureProviderAbortFns(fns: Partial<Record<LLMProvider, ProviderAbortFn>>): void {
  abortFns = fns;
}

export function getProviderAbortFn(provider: string): ProviderAbortFn | undefined {
  return abortFns[provider as LLMProvider];
}
