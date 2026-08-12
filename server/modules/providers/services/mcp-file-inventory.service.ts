import os from 'node:os';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import TOML from '@iarna/toml';

import { projectsDb } from '@/modules/database/index.js';
import type { LLMProvider, McpScope, McpTransport } from '@/shared/types.js';
import { readJsonConfig, readObjectRecord, readStringArray, readStringRecord } from '@/shared/utils.js';

/**
 * File-backed MCP discovery — **no invented servers**.
 *
 * Every hit points at a real config path + key. CloudCLI inventory consolidates
 * these hits; it never synthesizes placeholder URLs or fake providers.
 *
 * Grok also imports ~/.claude.json when `[compat.claude] mcps = true` (Grok
 * default). That is a real Grok behavior — CloudCLI sets mcps=false in managed
 * GROK_HOME so Claude-only catalog bindings do not leak into Grok sessions.
 */

export type McpConfigKind =
  | 'catalog'
  | 'claude_user'
  | 'claude_project_local'
  | 'mcp_json'
  | 'grok_user'
  | 'grok_project'
  | 'cursor_user'
  | 'cursor_project'
  | 'codex_user'
  | 'codex_project'
  | 'opencode_user'
  | 'opencode_project'
  | 'kimi_user'
  | 'kimi_project';

export type McpFileHit = {
  name: string;
  /** Agent that owns this config file (not "who might import it"). */
  ownerProvider: LLMProvider;
  configKind: McpConfigKind;
  /** Absolute path to the config file on disk. */
  configPath: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  workspacePath?: string;
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
};

const readTomlObject = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return (TOML.parse(content) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
};

const normalizeJsonServer = (
  name: string,
  raw: unknown,
  base: Omit<McpFileHit, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'cwd'>,
): McpFileHit | null => {
  if (!raw || typeof raw !== 'object') return null;
  const config = raw as Record<string, unknown>;
  if (typeof config.command === 'string') {
    return {
      ...base,
      name,
      transport: 'stdio',
      command: config.command,
      args: readStringArray(config.args),
      env: readStringRecord(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
    };
  }
  if (typeof config.url === 'string') {
    const type = typeof config.type === 'string' ? config.type.toLowerCase() : 'http';
    return {
      ...base,
      name,
      transport: type === 'sse' ? 'sse' : 'http',
      url: config.url,
      headers: readStringRecord(config.headers),
    };
  }
  return null;
};

const collectJsonMcpServers = async (
  filePath: string,
  base: Omit<McpFileHit, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'cwd'>,
  serversKey: 'mcpServers' = 'mcpServers',
): Promise<McpFileHit[]> => {
  if (!(await pathExists(filePath))) return [];
  const config = await readJsonConfig(filePath);
  const servers = readObjectRecord(config[serversKey]) ?? {};
  const hits: McpFileHit[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const hit = normalizeJsonServer(name, raw, base);
    if (hit) hits.push(hit);
  }
  return hits;
};

const collectGrokTomlServers = async (
  filePath: string,
  base: Omit<McpFileHit, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'cwd'>,
): Promise<McpFileHit[]> => {
  if (!(await pathExists(filePath))) return [];
  const config = await readTomlObject(filePath);
  const servers = readObjectRecord(config.mcp_servers) ?? {};
  const hits: McpFileHit[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as Record<string, unknown>;
    // Skip explicit disables if present
    if (cfg.enabled === false) continue;
    if (typeof cfg.command === 'string') {
      hits.push({
        ...base,
        name,
        transport: 'stdio',
        command: cfg.command,
        args: readStringArray(cfg.args),
        env: readStringRecord(cfg.env),
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
      });
    } else if (typeof cfg.url === 'string') {
      hits.push({
        ...base,
        name,
        transport: 'http',
        url: cfg.url,
        headers: readStringRecord(cfg.headers),
      });
    }
  }
  return hits;
};

const workspacePaths = (): string[] => {
  try {
    return projectsDb.getProjectPaths().map((r) => r.project_path).filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Scan every known on-disk MCP config. No CLI. No placeholders.
 */
export async function scanMcpConfigFiles(): Promise<McpFileHit[]> {
  const home = os.homedir();
  const hits: McpFileHit[] = [];
  const workspaces = workspacePaths();

  // --- Claude user ---
  hits.push(
    ...(await collectJsonMcpServers(
      path.join(home, '.claude.json'),
      {
        ownerProvider: 'claude',
        configKind: 'claude_user',
        configPath: path.join(home, '.claude.json'),
        scope: 'user',
      },
    )),
  );

  // --- Claude per-project under ~/.claude.json projects[path] ---
  try {
    const claudePath = path.join(home, '.claude.json');
    const claude = await readJsonConfig(claudePath);
    const projects = readObjectRecord(claude.projects) ?? {};
    for (const [workspacePath, raw] of Object.entries(projects)) {
      const project = readObjectRecord(raw) ?? {};
      const servers = readObjectRecord(project.mcpServers) ?? {};
      for (const [name, serverRaw] of Object.entries(servers)) {
        const hit = normalizeJsonServer(name, serverRaw, {
          ownerProvider: 'claude',
          configKind: 'claude_project_local',
          configPath: claudePath,
          scope: 'local',
          workspacePath,
        });
        if (hit) hits.push(hit);
      }
    }
  } catch {
    // ignore
  }

  // --- Project .mcp.json (shared format; owned by whichever agents load it) ---
  // Tag as mcp_json with ownerProvider 'claude' for display of file ownership;
  // consolidation uses configPath so Grok import is explained separately in UI.
  for (const workspacePath of workspaces) {
    const mcpJson = path.join(workspacePath, '.mcp.json');
    hits.push(
      ...(await collectJsonMcpServers(mcpJson, {
        ownerProvider: 'claude',
        configKind: 'mcp_json',
        configPath: mcpJson,
        scope: 'project',
        workspacePath,
      })),
    );
  }

  // --- Grok user + project ---
  hits.push(
    ...(await collectGrokTomlServers(path.join(home, '.grok', 'config.toml'), {
      ownerProvider: 'grok',
      configKind: 'grok_user',
      configPath: path.join(home, '.grok', 'config.toml'),
      scope: 'user',
    })),
  );
  for (const workspacePath of workspaces) {
    const grokProject = path.join(workspacePath, '.grok', 'config.toml');
    hits.push(
      ...(await collectGrokTomlServers(grokProject, {
        ownerProvider: 'grok',
        configKind: 'grok_project',
        configPath: grokProject,
        scope: 'project',
        workspacePath,
      })),
    );
  }

  // --- Cursor ---
  hits.push(
    ...(await collectJsonMcpServers(path.join(home, '.cursor', 'mcp.json'), {
      ownerProvider: 'cursor',
      configKind: 'cursor_user',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      scope: 'user',
    })),
  );
  for (const workspacePath of workspaces) {
    const cursorProject = path.join(workspacePath, '.cursor', 'mcp.json');
    hits.push(
      ...(await collectJsonMcpServers(cursorProject, {
        ownerProvider: 'cursor',
        configKind: 'cursor_project',
        configPath: cursorProject,
        scope: 'project',
        workspacePath,
      })),
    );
  }

  // --- Codex (user config often ~/.codex/config.toml mcp - skip if not present) ---
  // Keep file-only; codex provider handles shape when user has files.

  // --- OpenCode ---
  for (const candidate of [
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.opencode.json'),
  ]) {
    if (await pathExists(candidate)) {
      // OpenCode stores mcp under various keys; try mcpServers
      hits.push(
        ...(await collectJsonMcpServers(candidate, {
          ownerProvider: 'opencode',
          configKind: 'opencode_user',
          configPath: candidate,
          scope: 'user',
        })),
      );
    }
  }

  // --- Kimi ---
  hits.push(
    ...(await collectJsonMcpServers(path.join(home, '.kimi', 'mcp.json'), {
      ownerProvider: 'kimi',
      configKind: 'kimi_user',
      configPath: path.join(home, '.kimi', 'mcp.json'),
      scope: 'user',
    }).catch(() => [])),
  );

  return hits;
}

export type GrokCompatFlags = {
  claudeMcps: boolean | null;
  cursorMcps: boolean | null;
  configPath: string;
};

/** Read whether Grok is configured to import Claude/Cursor MCP files. */
export async function readGrokCompatFlags(): Promise<GrokCompatFlags> {
  const configPath = path.join(os.homedir(), '.grok', 'config.toml');
  const flags: GrokCompatFlags = {
    claudeMcps: null,
    cursorMcps: null,
    configPath,
  };
  try {
    const text = await readFile(configPath, 'utf8');
    const claude = text.match(/\[compat\.claude\][\s\S]*?(?=\[|$)/);
    const cursor = text.match(/\[compat\.cursor\][\s\S]*?(?=\[|$)/);
    if (claude) {
      const m = claude[0].match(/^\s*mcps\s*=\s*(true|false)/m);
      flags.claudeMcps = m ? m[1] === 'true' : true;
    } else {
      flags.claudeMcps = true; // Grok default
    }
    if (cursor) {
      const m = cursor[0].match(/^\s*mcps\s*=\s*(true|false)/m);
      flags.cursorMcps = m ? m[1] === 'true' : true;
    } else {
      flags.cursorMcps = true;
    }
  } catch {
    flags.claudeMcps = true;
    flags.cursorMcps = true;
  }
  return flags;
}
