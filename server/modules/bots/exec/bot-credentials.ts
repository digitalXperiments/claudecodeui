/**
 * Per-bot credentials for upstream MCP servers.
 *
 * Convention (the only thing that ties a secret to a bot and a server):
 *
 *   secret scope     'profile'
 *   secret scopeRef  `bot:<botId>`
 *   secret name      `<SERVER>__<ENV_OR_HEADER>`
 *
 * `<SERVER>` is the MCP server name upper-cased with every run of non-alphanumeric characters
 * replaced by one `_` (`jira-cloud` -> `JIRA_CLOUD`). `<ENV_OR_HEADER>` is the literal env var name
 * (stdio servers) or HTTP header name (http/sse servers), for example `JIRA_CLOUD__JIRA_API_TOKEN`
 * or `COMPOSIO__x-api-key`. When the Tool Gateway connects that bot to that server, each matching
 * secret replaces the server's shared env var / header of the same name; nothing is written into
 * the prompt. Values are only ever read server-side; the REST surface lists names.
 *
 * Bare `${secret:NAME}` resolution falls back to the global vault, so overrides are looked up by
 * secret id (scoped to this bot) and never pick up another bot's or a global secret by accident.
 */
import { secretsService } from '@/modules/secrets/index.js';

export const BOT_CREDENTIAL_SCOPE = 'profile' as const;
export const botCredentialScopeRef = (botId: string): string => `bot:${botId}`;

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SEPARATOR = '__';

export interface BotCredentialListing {
  server: string;
  key: string;
  /** The vault secret name (never the value). */
  name: string;
  updated_at: string;
  last_used_at: string | null;
}

/** `jira-cloud` -> `JIRA_CLOUD`. Returns '' when nothing usable remains. */
export function normalizeServerKey(server: string): string {
  return String(server ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isValidCredentialKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key) && !key.includes(SEPARATOR);
}

export function botCredentialSecretName(server: string, key: string): string {
  const serverKey = normalizeServerKey(server);
  if (!serverKey) throw new Error('Server name is required');
  if (!isValidCredentialKey(key)) throw new Error('Credential key must be an env var or header name (letters, digits, "_", "-", ".") without "__"');
  return `${serverKey}${SEPARATOR}${key}`;
}

export function parseBotCredentialName(name: string): { server: string; key: string } | null {
  const index = name.indexOf(SEPARATOR);
  if (index <= 0) return null;
  const server = name.slice(0, index);
  const key = name.slice(index + SEPARATOR.length);
  return server && isValidCredentialKey(key) ? { server, key } : null;
}

function ownedSecrets(botId: string) {
  const scopeRef = botCredentialScopeRef(botId);
  return secretsService.list(BOT_CREDENTIAL_SCOPE).filter((meta) => meta.scope_ref === scopeRef);
}

export const botCredentials = {
  /** Names only: server, key and timestamps. */
  list(botId: string): BotCredentialListing[] {
    const out: BotCredentialListing[] = [];
    for (const meta of ownedSecrets(botId)) {
      const parsed = parseBotCredentialName(meta.name);
      if (!parsed) continue;
      out.push({ ...parsed, name: meta.name, updated_at: meta.updated_at, last_used_at: meta.last_used_at });
    }
    return out.sort((a, b) => a.server.localeCompare(b.server) || a.key.localeCompare(b.key));
  },

  put(botId: string, server: string, key: string, value: string): BotCredentialListing {
    if (typeof value !== 'string' || value.length === 0) throw new Error('value must be a non-empty string');
    const name = botCredentialSecretName(server, key);
    const meta = secretsService.put({
      name,
      value,
      scope: BOT_CREDENTIAL_SCOPE,
      scopeRef: botCredentialScopeRef(botId),
      description: `Per-bot credential for ${normalizeServerKey(server)} (bot ${botId})`,
    });
    return { server: normalizeServerKey(server), key, name, updated_at: meta.updated_at, last_used_at: meta.last_used_at };
  },

  delete(botId: string, server: string, key: string): boolean {
    const name = botCredentialSecretName(server, key);
    const row = ownedSecrets(botId).find((meta) => meta.name === name);
    if (!row) return false;
    secretsService.delete(row.secret_id);
    return true;
  },

  /** Decrypted `{ ENV_OR_HEADER: value }` for one bot and server. Server-side use only. */
  resolveOverrides(botId: string, server: string): Record<string, string> {
    const serverKey = normalizeServerKey(server);
    const overrides: Record<string, string> = {};
    if (!serverKey) return overrides;
    for (const meta of ownedSecrets(botId)) {
      const parsed = parseBotCredentialName(meta.name);
      if (parsed?.server !== serverKey) continue;
      overrides[parsed.key] = secretsService.resolve(meta.secret_id);
    }
    return overrides;
  },
};
