/**
 * Recognises provider authentication failures in raw CLI/agent output.
 *
 * Unattended runners (Mission Control, Kanban generate) capture whatever the
 * provider printed and then try to parse it as the model's structured answer.
 * When the real problem is a dead login, that produced a misleading
 * "candidate is not JSON-shaped" parse error and parked the auth message as a
 * draft item — hiding the actual cause behind a format complaint.
 *
 * Detection is deliberately applied *only* on paths that already failed (a
 * non-zero run, or a JSON parse that threw), never to text that parsed fine, so
 * a summary that merely quotes the word "unauthorized" can't hijack a good run.
 */

/**
 * Distinctive auth-failure signatures. Kept specific on purpose: generic tokens
 * like "401" or "unauthorized" alone appear in legitimate content (Slack
 * threads, HTTP logs, Jira tickets) and are only matched with auth context.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  // Claude Code
  /OAuth\s+session\s+expired/i,
  /failed\s+to\s+authenticate/i,
  /Claude\s+login\s+has\s+expired/i,
  /run\s+`?claude\s+(?:auth\s+)?\/?login`?/i,
  /not\s+authenticated\.\s*run/i,
  // Token / key problems shared across providers
  /invalid\s+(?:api\s+)?(?:key|token)/i,
  /(?:api\s+)?key\s+(?:is\s+)?(?:missing|not\s+(?:set|configured|found))/i,
  /expired\s+(?:access\s+|refresh\s+|bearer\s+)?token/i,
  /(?:refresh|access)\s+token\s+(?:is\s+)?(?:invalid|expired|revoked)/i,
  /could\s+not\s+be\s+refreshed/i,
  /re-?authenticate/i,
  /please\s+(?:re)?log\s?in/i,
  /session\s+(?:has\s+)?expired/i,
  // Structured API error codes
  /"?type"?\s*[:=]\s*"?authentication_error"?/i,
  /\binvalid_grant\b/i,
  /\bunauthenticated\b/i,
  // HTTP status only when paired with auth wording
  /\b401\b[^\n]{0,60}\b(?:unauthorized|unauthenticated|invalid|expired|token|credential|auth)/i,
  /\b(?:unauthorized|forbidden)\b[^\n]{0,40}\b(?:401|403)\b/i,
  /\b403\b[^\n]{0,60}\b(?:invalid|expired)\s+(?:token|credential|key)/i,
];

/** Longest slice of raw output we bother scanning. */
const MAX_SCAN_LENGTH = 20_000;

/**
 * Returns the matched auth-failure line when `raw` looks like an auth failure,
 * otherwise null.
 *
 * The returned string is the offending line (trimmed and length-capped) so
 * callers can surface the provider's own wording instead of inventing one.
 */
export function detectProviderAuthFailure(raw: string | null | undefined): string | null {
  const text = (raw ?? '').slice(0, MAX_SCAN_LENGTH);
  if (!text.trim()) return null;

  const matched = AUTH_FAILURE_PATTERNS.find((pattern) => pattern.test(text));
  if (!matched) return null;

  // Prefer the specific line that tripped the match — the surrounding output is
  // usually a stack trace or JSON envelope that adds no signal for the user.
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry && matched.test(entry));

  return (line ?? text.trim()).slice(0, 300);
}

/**
 * Builds the operator-facing message for an auth failure on `provider`.
 * Names the provider and the command that fixes it, because these surface in
 * unattended run history where there is no session to inspect.
 */
export function buildProviderAuthFailureMessage(provider: string, detail: string): string {
  const loginHint = provider === 'claude'
    ? 'Run `claude auth login` (or `claude /login`) to re-authenticate'
    : `Re-authenticate the "${provider}" CLI`;
  return `Provider "${provider}" is not authenticated: ${detail}. ${loginHint}, then re-run.`;
}

/**
 * Convenience wrapper: inspects a run's error channel first, then its text, and
 * returns a ready-to-store message when either indicates an auth failure.
 */
export function resolveProviderAuthFailure(
  provider: string,
  errorMessage: string | null | undefined,
  text: string | null | undefined,
): string | null {
  const detail = detectProviderAuthFailure(errorMessage) ?? detectProviderAuthFailure(text);
  return detail ? buildProviderAuthFailureMessage(provider, detail) : null;
}
