import { authenticatedFetch } from '../../../utils/api';
import type { ProviderUsageResponse } from '../types/providerUsage';

type ApiEnvelope = {
  data?: ProviderUsageResponse;
  error?: { message?: string } | string;
};

export type FetchProviderUsageOptions = {
  fresh?: boolean;
  authChange?: boolean;
  signal?: AbortSignal;
};

export async function fetchProviderUsage(
  options: FetchProviderUsageOptions = {},
): Promise<ProviderUsageResponse> {
  const params = new URLSearchParams();
  if (options.fresh) {
    params.set('fresh', '1');
  }
  if (options.authChange) {
    params.set('authChange', '1');
  }
  const query = params.toString();
  const response = await authenticatedFetch(`/api/provider-usage${query ? `?${query}` : ''}`, {
    signal: options.signal,
  });

  let payload: ProviderUsageResponse | ApiEnvelope | null = null;
  try {
    payload = await response.json() as ProviderUsageResponse | ApiEnvelope;
  } catch {
    // The status-based fallback below gives callers a useful error message.
  }

  if (!response.ok) {
    const envelope = payload as ApiEnvelope | null;
    const nestedError = envelope?.error;
    const message = typeof nestedError === 'string'
      ? nestedError
      : nestedError?.message;
    throw new Error(message || `Provider usage request failed (HTTP ${response.status})`);
  }

  const envelope = payload as ApiEnvelope | null;
  const result = envelope?.data && Array.isArray(envelope.data.providers)
    ? envelope.data
    : payload as ProviderUsageResponse | null;
  if (!result || !Array.isArray(result.providers)) {
    throw new Error('Provider usage response was invalid');
  }

  return result;
}
