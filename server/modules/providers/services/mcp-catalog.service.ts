import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';

import { projectsDb } from '@/modules/database/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import {
  listMcpServersFromCli,
} from '@/modules/providers/services/mcp-cli-list.service.js';
import type {
  LLMProvider,
  McpCatalogBindingsUpdateInput,
  McpCatalogDefinition,
  McpCatalogEntry,
  McpCatalogSyncResult,
  McpCatalogUpsertInput,
  McpInventoryItem,
  McpScope,
  McpTransport,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * CloudCLI MCP catalog — single source of truth for local MCP definitions.
 *
 * Canonical store: `~/.cloudcli/mcp/catalog.json`
 * Provider configs are projections written via each provider's MCP adapter
 * (different syntax: Claude JSON, Grok TOML, Cursor mcp.json, etc.).
 *
 * Isolation: a server only appears on a provider when its binding is enabled.
 * Provider-cloud connectors (claude.ai / grok.com) are never cataloged or
 * fanned out; they appear only in inventory under that provider.
 */

const CATALOG_DIR_SEGMENTS = ['.cloudcli', 'mcp'] as const;
const CATALOG_FILE_NAME = 'catalog.json';

type CatalogFile = {
  version: 1;
  servers: Record<string, McpCatalogDefinition>;
};

/** Provider-ready MCP connection, resolved from a catalog entry. See {@link mcpCatalogService.resolveForProvider}. */
export type ResolvedMcpServerConnection = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

const getCatalogDir = (): string => path.join(os.homedir(), ...CATALOG_DIR_SEGMENTS);
const getCatalogPath = (): string => path.join(getCatalogDir(), CATALOG_FILE_NAME);

const ALL_MCP_PROVIDERS: LLMProvider[] = [
  'claude',
  'cursor',
  'codex',
  'opencode',
  'grok',
  'kimi',
  'pi',
];

const normalizeName = (name: string): string => {
  const normalized = name.trim();
  if (!normalized) {
    throw new AppError('MCP server name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  return normalized;
};

const emptyCatalog = (): CatalogFile => ({ version: 1, servers: {} });

const readCatalog = async (): Promise<CatalogFile> => {
  const raw = await readJsonConfig(getCatalogPath());
  if (!raw || typeof raw !== 'object') {
    return emptyCatalog();
  }
  const servers = (raw as CatalogFile).servers;
  if (!servers || typeof servers !== 'object') {
    return emptyCatalog();
  }
  return { version: 1, servers: servers as Record<string, McpCatalogDefinition> };
};

const writeCatalog = async (catalog: CatalogFile): Promise<void> => {
  await mkdir(getCatalogDir(), { recursive: true });
  await writeJsonConfig(getCatalogPath(), catalog);
};

/**
 * Resolve `${secret:…}` refs in env/headers before writing provider-native
 * configs. Missing secrets keep the original ref so fan-out does not fail;
 * CloudCLI runtime resolve (resolveForProvider) will still surface the error
 * when a session actually needs the value.
 */
const resolveSecretsForFanout = <T extends Record<string, string> | undefined>(
  values: T,
  provider: LLMProvider,
): T => {
  if (!values || Object.keys(values).length === 0) {
    return values;
  }
  try {
    return secretsService.resolveInObject(values, { provider });
  } catch (error) {
    console.warn(
      `[mcp-catalog] secret resolve skipped during fan-out for ${provider}:`,
      error instanceof Error ? error.message : error,
    );
    return values;
  }
};

const toUpsertInput = (
  def: McpCatalogDefinition,
  provider?: LLMProvider,
): UpsertProviderMcpServerInput => ({
  name: def.name,
  transport: def.transport,
  scope: def.scope,
  workspacePath: def.workspacePath,
  command: def.command,
  args: def.args,
  env: provider ? resolveSecretsForFanout(def.env, provider) : def.env,
  cwd: def.cwd,
  url: def.url,
  headers: provider ? resolveSecretsForFanout(def.headers, provider) : def.headers,
  envVars: def.envVars,
  bearerTokenEnvVar: def.bearerTokenEnvVar,
  envHttpHeaders: provider
    ? resolveSecretsForFanout(def.envHttpHeaders, provider)
    : def.envHttpHeaders,
});

const enabledProviders = (def: McpCatalogDefinition): LLMProvider[] => (
  ALL_MCP_PROVIDERS.filter((p) => def.bindings[p]?.enabled === true)
);

const buildBindings = (
  providers: LLMProvider[] | undefined,
): Partial<Record<LLMProvider, { enabled: boolean }>> => {
  const bindings: Partial<Record<LLMProvider, { enabled: boolean }>> = {};
  for (const p of ALL_MCP_PROVIDERS) {
    bindings[p] = { enabled: false };
  }
  for (const p of providers ?? []) {
    if (ALL_MCP_PROVIDERS.includes(p)) {
      bindings[p] = { enabled: true };
    }
  }
  return bindings;
};

/**
 * Fan-out: write or remove projections for each provider based on desired bindings.
 * Uses existing provider adapters so syntax stays provider-specific.
 */
const syncBindings = async (
  def: McpCatalogDefinition,
  previousEnabled: LLMProvider[],
): Promise<McpCatalogSyncResult[]> => {
  const desired = new Set(enabledProviders(def));
  const previous = new Set(previousEnabled);
  const results: McpCatalogSyncResult[] = [];

  for (const provider of ALL_MCP_PROVIDERS) {
    const want = desired.has(provider);
    const had = previous.has(provider);
    if (!want && !had) {
      continue;
    }

    try {
      if (want) {
        // Per-provider resolve so provider-scoped vault secrets can apply.
        await providerMcpService.upsertProviderMcpServer(provider, toUpsertInput(def, provider));
        results.push({ provider, ok: true });
      } else if (had) {
        await providerMcpService.removeProviderMcpServer(provider, {
          name: def.name,
          scope: def.scope,
          workspacePath: def.workspacePath,
        });
        results.push({ provider, ok: true });
      }
    } catch (error) {
      results.push({
        provider,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
};

const isProviderCloudName = (name: string): boolean => (
  /^claude\.ai\b/i.test(name)
  || /^grok\.com\b/i.test(name)
  || /^grok_com_/i.test(name)
);

const isGrokProjectMcpUrl = (url?: string): boolean => (
  typeof url === 'string' && url.startsWith('grok-project-mcp://')
);

const cloudLabelFor = (
  provider: LLMProvider | undefined,
  name: string,
  url?: string,
): string | undefined => {
  if (/^claude\.ai\b/i.test(name)) return 'Claude.ai';
  if (
    /^grok\.com\b/i.test(name)
    || /^grok_com_/i.test(name)
    || isGrokProjectMcpUrl(url)
    || (provider === 'grok' && /^https?:\/\/leongassociates/i.test(url || ''))
  ) {
    return 'Grok.com';
  }
  if (provider === 'claude' && isProviderCloudName(name)) return 'Claude.ai';
  if (provider === 'grok' && isProviderCloudName(name)) return 'Grok.com';
  return undefined;
};

const classifySource = (args: {
  name: string;
  url?: string;
  target?: string;
  provider?: LLMProvider;
  command?: string;
  transport?: McpTransport;
}): McpInventoryItem['source'] => {
  if (isManagedName(args.name)) return 'managed';
  // Local stdio installs are always on-disk / native — even if Grok also has a
  // project cache folder for the same name (e.g. obsidian).
  if (looksLikeLocalStdio({ command: args.command, transport: args.transport, url: args.url })) {
    return 'provider_native';
  }
  if (isProviderCloudName(args.name)) {
    return 'provider_cloud';
  }
  // Placeholder URLs only count as cloud when the name itself is hosted-like.
  if (isGrokProjectMcpUrl(args.url) && isGrokHostedCacheName(args.name)) {
    return 'provider_cloud';
  }
  if (isGrokProjectMcpUrl(args.url)) {
    // e.g. grok-project-mcp://obsidian with no command yet — still treat as
    // native until proven hosted; cache dirs are not proof of grok.com ownership.
    return 'provider_native';
  }
  return 'provider_native';
};

const isManagedName = (name: string): boolean => name.startsWith('cloudcli-');

/**
 * Stable identity for dedupe across providers / naming styles.
 *
 * Cloud connectors are **namespaced** so they never collide with local servers
 * or each other:
 *   - "claude.ai Gmail"  → claudeai:gmail
 *   - Grok project "GMail" / grok_com_* → grokcom:gmail
 *   - "leong-associates-mcp" / "Leong Associates MCP" → leongassociates
 *   - local "obsidian" → obsidian
 */
const normalizeMcpIdentity = (name: string): string => {
  const lower = name.toLowerCase().trim();
  if (!lower) return '';

  if (lower.startsWith('claude.ai ') || lower.startsWith('claude.ai')) {
    const rest = lower.replace(/^claude\.ai[\s._-]*/i, '');
    return `claudeai:${rest.replace(/[_-]?mcp$/i, '').replace(/[^a-z0-9]+/g, '')}`;
  }
  if (lower.startsWith('grok.com ') || lower.startsWith('grok_com_') || lower.startsWith('grok.com')) {
    const rest = lower.replace(/^grok(?:\.com|\_com)[\s._-]*/i, '');
    return `grokcom:${rest.replace(/[_-]?mcp$/i, '').replace(/[^a-z0-9]+/g, '')}`;
  }

  return lower
    .replace(/[_-]?mcp$/i, '')
    .replace(/[^a-z0-9]+/g, '');
};

const isPlaceholderGrokUrl = (url?: string): boolean => (
  typeof url === 'string' && url.startsWith('grok-project-mcp://')
);

const isRealHttpUrl = (url?: string): boolean => (
  typeof url === 'string' && /^https?:\/\//i.test(url)
);

/** Local stdio install (npx/node/python path) — never a provider-cloud connector. */
const looksLikeLocalStdio = (item: Pick<McpInventoryItem, 'command' | 'transport' | 'url'>): boolean => {
  if (item.transport === 'stdio' && item.command) return true;
  if (item.command && !isRealHttpUrl(item.url) && !isPlaceholderGrokUrl(item.url)) return true;
  return false;
};

/**
 * Grok project-cache folder names that are true hosted connectors (not local
 * stdio tools that also happen to have a project cache dir).
 */
const isGrokHostedCacheName = (name: string): boolean => {
  const n = name.trim();
  if (/^grok_com_/i.test(n)) return true;
  if (/^claude\.ai\b/i.test(n)) return false;
  // Google/Grok hosted short names commonly cached under projects/*/mcps
  if (/^(GMail|Gmail|Google Calendar|Google Drive|Slack)$/i.test(n)) return true;
  return false;
};

const rankSource = (source: McpInventoryItem['source']): number => {
  switch (source) {
    case 'cloudcli': return 0;
    case 'managed': return 1;
    case 'provider_cloud': return 2;
    default: return 3;
  }
};

/**
 * Discover every Grok project-scoped MCP folder under ~/.grok/projects/<id>/mcps.
 * Hosted connectors often only appear here, never in config.toml or `grok mcp list`.
 */
const listAllGrokProjectMcpNames = async (): Promise<string[]> => {
  const root = path.join(os.homedir(), '.grok', 'projects');
  const names = new Set<string>();
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const mcpsDir = path.join(root, project.name, 'mcps');
      try {
        const entries = await readdir(mcpsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            names.add(entry.name);
          }
        }
      } catch {
        // missing mcps dir
      }
    }
  } catch {
    // no projects root
  }
  return [...names];
};

/**
 * Upsert one inventory row, merging by normalized identity so Claude + Grok
 * projections of the same local server appear once with multi-provider chips.
 * Real HTTPS endpoints always win over grok-project-mcp:// placeholders.
 */
const upsertInventoryItem = (
  items: McpInventoryItem[],
  incoming: McpInventoryItem,
  catalogIdentities: Set<string>,
): void => {
  const identity = normalizeMcpIdentity(incoming.name);
  if (!identity) return;

  // Catalog is source of truth for *who is enabled* (bindings). Discovery may
  // only attach health — never invent extra provider chips from CLI/doctor.
  if (catalogIdentities.has(identity)) {
    const catalogRow = items.find(
      (i) => i.source === 'cloudcli' && normalizeMcpIdentity(i.name) === identity,
    );
    if (catalogRow) {
      if (incoming.connected != null) catalogRow.connected = incoming.connected;
      if (incoming.needsAuth) catalogRow.needsAuth = true;
    }
    return;
  }

  const existing = items.find((i) => normalizeMcpIdentity(i.name) === identity);
  if (!existing) {
    items.push(incoming);
    return;
  }

  // Merge providers only when identities already matched. Still block mixing
  // Claude-only cloud chips onto Grok-only cloud rows via originProvider rules.
  const cloudLocked = existing.source === 'provider_cloud' || incoming.source === 'provider_cloud';
  if (cloudLocked) {
    // Cloud connectors stay single-provider (their origin account).
    const owner = existing.originProvider
      ?? incoming.originProvider
      ?? existing.providers[0]
      ?? incoming.providers[0];
    if (owner) {
      existing.providers = [owner];
      existing.originProvider = owner;
    }
  } else {
    for (const p of incoming.providers) {
      if (!existing.providers.includes(p)) existing.providers.push(p);
    }
  }

  if (incoming.connected != null) existing.connected = incoming.connected;
  if (incoming.needsAuth) existing.needsAuth = true;

  // Prefer higher-value source, but **demote** false provider_cloud when we
  // discover a real local stdio command (obsidian via npx is not grok.com).
  if (looksLikeLocalStdio(incoming) || looksLikeLocalStdio(existing)) {
    if (existing.source === 'provider_cloud' && !isProviderCloudName(existing.name)) {
      existing.source = 'provider_native';
      existing.cloudLabel = undefined;
    }
    if (incoming.source === 'provider_native' || looksLikeLocalStdio(incoming)) {
      if (existing.source !== 'cloudcli' && existing.source !== 'managed') {
        existing.source = 'provider_native';
        existing.cloudLabel = undefined;
      }
    }
  } else {
    const rank: Record<McpInventoryItem['source'], number> = {
      cloudcli: 0,
      managed: 1,
      provider_cloud: 2,
      provider_native: 3,
    };
    if (rank[incoming.source] < rank[existing.source]) {
      existing.source = incoming.source;
      existing.cloudLabel = incoming.cloudLabel ?? existing.cloudLabel;
      existing.kind = incoming.kind ?? existing.kind;
    } else if (
      incoming.source === 'provider_cloud'
      && !looksLikeLocalStdio(existing)
    ) {
      existing.source = 'provider_cloud';
      existing.cloudLabel = existing.cloudLabel ?? incoming.cloudLabel ?? 'Grok.com';
    }
  }

  // Prefer real HTTP/SSE URL over placeholder; keep richer command/env
  if (isRealHttpUrl(incoming.url) && !isRealHttpUrl(existing.url)) {
    existing.url = incoming.url;
    existing.transport = incoming.transport ?? existing.transport;
  } else if (isPlaceholderGrokUrl(existing.url) && incoming.url && !isPlaceholderGrokUrl(incoming.url)) {
    existing.url = incoming.url;
  } else if (!existing.url && incoming.url && !isPlaceholderGrokUrl(incoming.url)) {
    existing.url = incoming.url;
  }
  // Drop placeholder URL once we have a local command
  if (looksLikeLocalStdio(existing) && isPlaceholderGrokUrl(existing.url)) {
    existing.url = undefined;
  }

  if ((!existing.command || existing.command.length < (incoming.command?.length ?? 0)) && incoming.command) {
    existing.command = incoming.command;
    existing.args = incoming.args ?? existing.args;
    existing.transport = incoming.transport ?? existing.transport ?? 'stdio';
  }
  if (incoming.env && Object.keys(incoming.env).length > 0 && (!existing.env || Object.keys(existing.env).length === 0)) {
    existing.env = incoming.env;
  }
  if (incoming.headers && Object.keys(incoming.headers).length > 0) {
    existing.headers = { ...(existing.headers ?? {}), ...incoming.headers };
  }
  // Prefer a nicer display name (spaces / Title Case over kebab) within same identity
  if (
    incoming.name.includes(' ')
    && !existing.name.includes(' ')
  ) {
    existing.name = incoming.name;
  }
};


const workspacePathsSafe = (): string[] => {
  try {
    return projectsDb.getProjectPaths().map((r) => r.project_path).filter(Boolean);
  } catch {
    return [];
  }
};

export const mcpCatalogService = {
  /**
   * List catalog-only entries (CloudCLI source of truth).
   */
  async listCatalog(): Promise<McpCatalogEntry[]> {
    const catalog = await readCatalog();
    return Object.values(catalog.servers)
      .map((server) => ({ ...server, source: 'cloudcli' as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Resolve a set of catalog server names into connection definitions ready
   * to hand a provider's own runtime (e.g. an ACP `session/new` `mcpServers`
   * array) — as opposed to the tool-name-string allow-lists produced by
   * `expandMcpSelectionsToTools`.
   *
   * A name is only resolved when it exists in the catalog **and** its
   * `bindings[provider].enabled` is true — this is the same isolation gate
   * fan-out uses, so a task can only reach servers explicitly enabled for
   * that provider.
   */
  async resolveForProvider(
    provider: LLMProvider,
    names: string[],
  ): Promise<ResolvedMcpServerConnection[]> {
    const wanted = new Set(names.map((n) => n.trim()).filter(Boolean));
    if (wanted.size === 0) return [];

    const catalog = await readCatalog();
    const out: ResolvedMcpServerConnection[] = [];
    for (const def of Object.values(catalog.servers)) {
      if (!wanted.has(def.name)) continue;
      if (!def.bindings[provider]?.enabled) continue;

      if (def.transport === 'stdio') {
        if (!def.command?.trim()) continue;
        out.push({
          name: def.name,
          transport: 'stdio',
          command: def.command,
          args: def.args ?? [],
          env: secretsService.resolveInObject(def.env ?? {}, { provider }),
          cwd: def.cwd,
        });
      } else {
        if (!def.url?.trim()) continue;
        out.push({
          name: def.name,
          transport: def.transport,
          url: def.url,
          headers: secretsService.resolveInObject(def.headers ?? {}, { provider }),
        });
      }
    }
    return out;
  },

  /**
   * Unified inventory from **real files only** (+ optional CLI for account
   * connectors that never live on disk).
   *
   * Never invents servers. Every native/cloud row carries configPaths/kinds.
   */
  async listInventory(_options?: { workspacePath?: string }): Promise<McpInventoryItem[]> {
    // Ensure Grok stops auto-importing ~/.claude.json (sticky Claude MCPs in /mcps).
    try {
      const { ensureUserGrokMcpIsolation } = await import('../../../shared/grok-home.js');
      ensureUserGrokMcpIsolation?.();
    } catch {
      // optional in tests / non-node paths
    }

    const catalog = await readCatalog();
    const items: McpInventoryItem[] = [];
    const byIdentity = new Map<string, McpInventoryItem>();

    const put = (item: McpInventoryItem) => {
      const id = normalizeMcpIdentity(item.name) || item.name.toLowerCase();
      const prev = byIdentity.get(id);
      if (!prev) {
        byIdentity.set(id, item);
        return;
      }
      // Catalog wins identity for bindings
      if (prev.source === 'cloudcli' || item.source === 'cloudcli') {
        const winner = prev.source === 'cloudcli' ? prev : item;
        const other = winner === prev ? item : prev;
        if (other.connected != null) winner.connected = other.connected;
        if (other.needsAuth) winner.needsAuth = true;
        // Merge evidence paths for transparency
        winner.configPaths = [...new Set([...(winner.configPaths ?? []), ...(other.configPaths ?? [])])];
        winner.configKinds = [...new Set([...(winner.configKinds ?? []), ...(other.configKinds ?? [])])];
        byIdentity.set(id, winner);
        return;
      }
      // Same non-catalog identity: merge file evidence + providers (owners only)
      for (const p of item.providers) {
        if (!prev.providers.includes(p)) prev.providers.push(p);
      }
      prev.configPaths = [...new Set([...(prev.configPaths ?? []), ...(item.configPaths ?? [])])];
      prev.configKinds = [...new Set([...(prev.configKinds ?? []), ...(item.configKinds ?? [])])];
      if (item.connected != null) prev.connected = item.connected;
      if (item.needsAuth) prev.needsAuth = true;
      if (isRealHttpUrl(item.url) && !isRealHttpUrl(prev.url)) {
        prev.url = item.url;
        prev.transport = item.transport ?? prev.transport;
      }
      if (item.command && !prev.command) {
        prev.command = item.command;
        prev.args = item.args;
        prev.transport = item.transport ?? prev.transport ?? 'stdio';
      }
      if (looksLikeLocalStdio(item) || looksLikeLocalStdio(prev)) {
        if (prev.source === 'provider_cloud' && !isProviderCloudName(prev.name)) {
          prev.source = 'provider_native';
          prev.cloudLabel = undefined;
        }
      }
      if (item.source === 'provider_cloud' && !looksLikeLocalStdio(prev)) {
        prev.source = 'provider_cloud';
        prev.cloudLabel = prev.cloudLabel ?? item.cloudLabel;
        prev.providers = item.providers.slice(0, 1);
        prev.originProvider = item.originProvider ?? item.providers[0];
      }
    };

    // 1) Catalog (CloudCLI source of truth for local definitions + bindings)
    for (const def of Object.values(catalog.servers)) {
      put({
        name: def.name,
        source: 'cloudcli',
        transport: def.transport,
        scope: def.scope,
        command: def.command,
        args: def.args,
        env: def.env,
        cwd: def.cwd,
        url: def.url,
        headers: def.headers,
        workspacePath: def.workspacePath,
        providers: enabledProviders(def),
        bindings: def.bindings,
        kind: def.kind,
        configPaths: [getCatalogPath()],
        configKinds: ['catalog'],
      });
    }

    // 2) Real config files on disk
    const { scanMcpConfigFiles, readGrokCompatFlags } = await import(
      '@/modules/providers/services/mcp-file-inventory.service.js'
    );
    const fileHits = await scanMcpConfigFiles();
    const grokCompat = await readGrokCompatFlags();

    for (const hit of fileHits) {
      const isManaged = hit.name.startsWith('cloudcli-');
      put({
        name: hit.name,
        source: isManaged ? 'managed' : 'provider_native',
        transport: hit.transport,
        scope: hit.scope,
        command: hit.command,
        args: hit.args,
        env: hit.env,
        cwd: hit.cwd,
        url: hit.url,
        headers: hit.headers,
        workspacePath: hit.workspacePath,
        providers: [hit.ownerProvider],
        originProvider: hit.ownerProvider,
        configPaths: [hit.configPath],
        configKinds: [hit.configKind],
      });
    }

    // 3) Account connectors only (not in files) — from provider CLIs with real source tags.
    //    No placeholders. No project-cache directory invention.
    for (const provider of ['claude', 'grok'] as LLMProvider[]) {
      try {
        const cliEntries = await listMcpServersFromCli(provider, {
          workspacePaths: provider === 'grok' ? workspacePathsSafe() : undefined,
        });
        for (const entry of cliEntries) {
          const isCloudName = isProviderCloudName(entry.name)
            || entry.source === 'grok.com'
            || (typeof entry.source === 'string' && /managed/i.test(entry.source));
          // Skip file-backed servers from CLI (already covered by scan).
          if (!isCloudName) continue;
          // Skip doctor noise from ~/.claude.json when listing as grok
          if (entry.ownerProvider && entry.ownerProvider !== provider && entry.ownerProvider !== undefined) {
            // still allow if name is clearly claude.ai and owner is claude
          }
          const owner = entry.ownerProvider
            ?? (entry.name.toLowerCase().startsWith('claude.ai') ? 'claude' : provider);
          // Only emit cloud rows for the owning account
          if (entry.name.toLowerCase().startsWith('claude.ai') && owner !== 'claude') continue;
          if ((entry.source === 'grok.com' || /^grok_com_/i.test(entry.name)) && owner !== 'grok') continue;

          const looksUrl = /^https?:\/\//i.test(entry.target);
          put({
            name: entry.name,
            source: 'provider_cloud',
            transport: entry.transport === 'sse' ? 'sse' : looksUrl ? 'http' : 'stdio',
            url: looksUrl ? entry.target.split(/\s+/)[0] : undefined,
            command: looksUrl ? undefined : entry.target.split(/\s+/)[0],
            args: looksUrl ? undefined : entry.target.split(/\s+/).slice(1),
            providers: [owner],
            originProvider: owner,
            connected: entry.connected,
            needsAuth: entry.needsAuth,
            cloudLabel: owner === 'claude' ? 'Claude.ai' : 'Grok.com',
            configPaths: entry.source ? [`cli:${provider}:${entry.source}`] : [`cli:${provider}`],
            configKinds: [entry.source === 'grok.com' || entry.source === 'managed' ? 'cli_grok_managed' : 'cli_account'],
          });
        }
      } catch {
        // CLI optional
      }
    }

    // Annotate Claude file hits that Grok would also load if compat.claude.mcps=true
    const result = [...byIdentity.values()].map((item) => {
      if (item.source === 'cloudcli') return item;
      if (looksLikeLocalStdio(item) && item.source === 'provider_cloud' && !isProviderCloudName(item.name)) {
        return { ...item, source: 'provider_native' as const, cloudLabel: undefined };
      }
      if (item.source === 'provider_cloud') {
        const owner = item.originProvider ?? item.providers[0];
        return { ...item, providers: owner ? [owner] : item.providers, originProvider: owner };
      }
      return item;
    });

    // Surface isolation note via managed empty path is enough; UI can show configPaths.
    void grokCompat;

    return result.sort((a, b) => {
      const rank = rankSource(a.source) - rankSource(b.source);
      if (rank !== 0) return rank;
      return a.name.localeCompare(b.name);
    });
  },

  /**
   * Create or update a catalog definition and sync projections to enabled providers.
   */
  async upsert(input: McpCatalogUpsertInput): Promise<McpCatalogEntry> {
    const name = normalizeName(input.name);
    if (input.transport !== 'stdio' && input.transport !== 'http' && input.transport !== 'sse') {
      throw new AppError('Invalid MCP transport.', {
        code: 'INVALID_MCP_TRANSPORT',
        statusCode: 400,
      });
    }
    if (input.transport === 'stdio' && !input.command?.trim()) {
      throw new AppError('command is required for stdio MCP servers.', {
        code: 'MCP_COMMAND_REQUIRED',
        statusCode: 400,
      });
    }
    if ((input.transport === 'http' || input.transport === 'sse') && !input.url?.trim()) {
      throw new AppError('url is required for http/sse MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    const scope = input.scope === 'user' ? 'user' : 'project';
    if (scope === 'project' && !input.workspacePath?.trim()) {
      // Allow project scope without path only if callers use cwd later; prefer requiring path.
    }

    const catalog = await readCatalog();
    const previous = catalog.servers[name];
    const previousEnabled = previous ? enabledProviders(previous) : [];

    // If providers omitted on update, keep existing bindings; on create default to none.
    let bindings = previous?.bindings ?? buildBindings([]);
    if (input.providers !== undefined) {
      bindings = buildBindings(input.providers);
    }

    const def: McpCatalogDefinition = {
      name,
      transport: input.transport as McpTransport,
      scope,
      workspacePath: input.workspacePath?.trim() || previous?.workspacePath,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      envVars: input.envVars,
      bearerTokenEnvVar: input.bearerTokenEnvVar,
      envHttpHeaders: input.envHttpHeaders,
      bindings,
      updatedAt: new Date().toISOString(),
      kind: input.kind ?? previous?.kind,
    };

    catalog.servers[name] = def;
    await writeCatalog(catalog);

    const syncResults = await syncBindings(def, previousEnabled);
    return { ...def, source: 'cloudcli', syncResults };
  },

  /**
   * Replace provider bindings (fan-out matrix) and sync.
   */
  async setBindings(input: McpCatalogBindingsUpdateInput): Promise<McpCatalogEntry> {
    const name = normalizeName(input.name);
    const catalog = await readCatalog();
    const existing = catalog.servers[name];
    if (!existing) {
      throw new AppError(`MCP catalog entry "${name}" not found.`, {
        code: 'MCP_CATALOG_NOT_FOUND',
        statusCode: 404,
      });
    }

    const previousEnabled = enabledProviders(existing);
    existing.bindings = buildBindings(input.providers);
    existing.updatedAt = new Date().toISOString();
    catalog.servers[name] = existing;
    await writeCatalog(catalog);

    const syncResults = await syncBindings(existing, previousEnabled);
    return { ...existing, source: 'cloudcli', syncResults };
  },

  /**
   * Remove catalog entry and tear down all managed projections.
   */
  async remove(nameInput: string): Promise<{ removed: boolean; name: string; syncResults: McpCatalogSyncResult[] }> {
    const name = normalizeName(nameInput);
    const catalog = await readCatalog();
    const existing = catalog.servers[name];
    if (!existing) {
      return { removed: false, name, syncResults: [] };
    }

    const previousEnabled = enabledProviders(existing);
    // Disable all bindings then sync removals
    existing.bindings = buildBindings([]);
    const syncResults = await syncBindings(existing, previousEnabled);

    delete catalog.servers[name];
    await writeCatalog(catalog);

    return { removed: true, name, syncResults };
  },

  /**
   * Adopt a provider-native server into the catalog and optionally fan out.
   */
  async adopt(input: {
    name: string;
    fromProvider: LLMProvider;
    scope?: McpScope;
    workspacePath?: string;
    providers?: LLMProvider[];
  }): Promise<McpCatalogEntry> {
    const name = normalizeName(input.name);
    const scope = (input.scope === 'user' || input.scope === 'local' || input.scope === 'project')
      ? input.scope
      : 'user';

    const servers = await providerMcpService.listProviderMcpServersForScope(
      input.fromProvider,
      scope === 'local' ? 'local' : scope,
      { workspacePath: input.workspacePath },
    );
    const found = servers.find((s) => s.name === name);
    if (!found) {
      throw new AppError(`Server "${name}" not found on ${input.fromProvider}.`, {
        code: 'MCP_ADOPT_NOT_FOUND',
        statusCode: 404,
      });
    }

    const providers = input.providers ?? [input.fromProvider];
    return this.upsert({
      name: found.name,
      transport: found.transport,
      scope: scope === 'local' ? 'user' : scope,
      workspacePath: input.workspacePath,
      command: found.command,
      args: found.args,
      env: found.env,
      cwd: found.cwd,
      url: found.url,
      headers: found.headers,
      envVars: found.envVars,
      bearerTokenEnvVar: found.bearerTokenEnvVar,
      envHttpHeaders: found.envHttpHeaders,
      providers,
    });
  },
};
