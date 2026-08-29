type ApiErrorEnvelope = {
  error?: unknown;
  message?: unknown;
};

/** Extract a useful message from both legacy string and structured API errors. */
export function apiErrorMessage(payload: ApiErrorEnvelope, fallback: string): string {
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  if (payload.error && typeof payload.error === 'object') {
    const message = (payload.error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  return fallback;
}
