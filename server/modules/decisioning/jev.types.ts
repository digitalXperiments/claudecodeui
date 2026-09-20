/**
 * TypeSafe "System One" (Jev) wire types and CloudCLI's capability model.
 *
 * Jev is a classifier, not a chat model: it returns typed answers and
 * probabilities, never prose. CloudCLI always defines the legal answers in
 * code and lets Jev only pick between them — it never invents a provider, a
 * path, a command, or a tool argument.
 */

/** One question about the state. Jev evaluates every question in parallel. */
export type JevQuestion =
  /** Yes/no. The answer is the probability the statement is true. */
  | { type: 'noul'; instructions: string }
  /** Pick one key from `criteria`. Returns the key plus a probability each. */
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  /** Rate against ordered levels. Returns a continuous score. */
  | { type: 'score'; instructions: string; criteria: string[] };

export type JevRequest = {
  model: string;
  state: string;
  questions: Record<string, JevQuestion>;
};

export type JevAnswer = {
  type?: string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  legend?: Record<string, unknown>;
  confidence?: number;
};

export type JevResponse = {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Injectable HTTP boundary. Tests and the shadow-mode harness replace this;
 * nothing else in CloudCLI knows how Jev is reached.
 */
export type JevTransport = (input: {
  url: string;
  apiKey: string;
  body: JevRequest;
  timeoutMs: number;
}) => Promise<JevResponse>;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Every distinct decision Jev is allowed to participate in. Each one is
 * independently switchable, because they carry very different blast radii:
 * scoring a finished report is harmless, while settling a permission request
 * is not.
 */
export type JevCapability =
  /** Adjudicate Agent Relay permission requests the host could not settle. */
  | 'relay_permissions'
  /** Assess a finished Agent Relay worker report. */
  | 'relay_results'
  /**
   * Answer "is the page ready, and did that action work?" inside a browser
   * tool call, so the driving agent does not need a whole extra turn plus a
   * 30k-character snapshot to find out.
   */
  | 'browser_page_state';

export const JEV_CAPABILITIES: JevCapability[] = [
  'relay_permissions',
  'relay_results',
  'browser_page_state',
];

/**
 * How far a capability is allowed to go.
 *
 * - `off`       — the code path is unreachable; no request is sent.
 * - `shadow`    — Jev is asked and the answer is recorded, but never applied.
 *                 This is the measurement stage.
 * - `enforcing` — the answer may be acted on, subject to each call site's own
 *                 guardrails. Enforcing may restrict; widening always needs a
 *                 further, capability-specific switch.
 */
export type JevCapabilityMode = 'off' | 'shadow' | 'enforcing';

export type JevSettings = {
  /** Master switch. With this off, no Jev code path is reachable at all. */
  enabled: boolean;
  model: string;
  baseUrl: string;
  /** Hard per-call bound. Call sites may lower it further, never raise it. */
  timeoutMs: number;
  /** Answers below this confidence are ignored everywhere. */
  confidenceThreshold: number;
  capabilities: Record<JevCapability, JevCapabilityMode>;
  /**
   * The one switch that lets Jev *widen* what an agent may do: permit an
   * enforcing `relay_permissions` to approve an escalation rather than only
   * deny it. Deliberately separate from the capability mode.
   */
  relayMayApprovePermissions: boolean;
};

export type JevSettingsPatch = Partial<Omit<JevSettings, 'capabilities'>> & {
  capabilities?: Partial<Record<JevCapability, JevCapabilityMode>>;
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

/** What every call site gets back, before it applies its own guardrails. */
export type JevDecision<TVerdict extends string> = {
  verdict: TVerdict;
  confidence: number;
  probabilities: Record<string, number>;
  /** Extra noul probabilities the call site asked for, keyed by question id. */
  signals: Record<string, number>;
  latencyMs: number;
  model: string;
  /** Non-null when the call failed; the call site must then keep old behavior. */
  error: string | null;
};
