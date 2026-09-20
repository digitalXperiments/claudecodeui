export type JevCapability = 'relay_permissions' | 'relay_results' | 'browser_page_state';

/**
 * - `off`       — the code path is unreachable; no request is sent.
 * - `shadow`    — Jev is asked and the answer recorded, but never applied.
 * - `enforcing` — the answer may be acted on, subject to each call site's own
 *                 guardrails.
 */
export type JevCapabilityMode = 'off' | 'shadow' | 'enforcing';

export type JevSettings = {
  enabled: boolean;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  confidenceThreshold: number;
  capabilities: Record<JevCapability, JevCapabilityMode>;
  /** The one switch that lets Jev widen what an agent may do. */
  relayMayApprovePermissions: boolean;
};

/** Masked credential status. The raw key never leaves the server. */
export type JevKeyStatus = {
  configured: boolean;
  source: 'stored' | 'env' | null;
  masked: string | null;
};

export type JevConnectionTest = {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  error: string | null;
};
