import type { LLMProvider } from '@/shared/types.js';

export const WEBHOOK_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'agy',
  'pi',
] as const satisfies readonly LLMProvider[];

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === 'string' && (WEBHOOK_PROVIDERS as readonly string[]).includes(value);
}

export type WebhookScope = 'global' | 'project';

export type WebhookDeliveryStatus = 'accepted' | 'running' | 'done' | 'failed';

export type WebhookSource = {
  source_id: string;
  source: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: WebhookProvider;
  model: string | null;
  prompt: string;
  permission_mode: string;
  mcp_tools: string[];
  skills: string[];
  profile_id: string | null;
  scope: WebhookScope;
  project_id: string | null;
  retryMax: number;
  retryBackoffSeconds: number;
  secret: string | null;
  /** Internal vault reference; never serialize this through config routes. */
  secret_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookDelivery = {
  delivery_id: string;
  source_id: string;
  status: WebhookDeliveryStatus;
  request: Record<string, unknown>;
  app_session_id: string | null;
  agent_run_id: string | null;
  error_message: string | null;
  result_preview: string | null;
  attempt: number;
  next_retry_at: string | null;
  created_at: string;
  finished_at: string | null;
};

export type CreateWebhookSourceInput = {
  source: string;
  name: string;
  description?: string;
  enabled?: boolean;
  provider?: WebhookProvider;
  model?: string | null;
  prompt?: string;
  permission_mode?: string;
  mcp_tools?: string[];
  skills?: string[];
  profile_id?: string | null;
  scope?: WebhookScope;
  project_id?: string | null;
  retryMax?: number;
  retryBackoffSeconds?: number;
  secret?: string | null;
};

export type UpdateWebhookSourceInput = {
  source?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  provider?: WebhookProvider;
  model?: string | null;
  prompt?: string;
  permission_mode?: string;
  mcp_tools?: string[];
  skills?: string[];
  profile_id?: string | null;
  scope?: WebhookScope;
  project_id?: string | null;
  retryMax?: number;
  retryBackoffSeconds?: number;
  secret?: string | null;
};

/** Normalized fields extracted from body / query / headers on ingest. */
export type WebhookIngestPayload = {
  source: string;
  text: string;
  title: string;
  payload: Record<string, unknown> | unknown;
  meta: Record<string, unknown>;
  raw: Record<string, unknown>;
};
