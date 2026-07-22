/**
 * Agent run profiles — named reusable provider/model/effort/permission configs.
 */

import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { LLMProvider } from '@/shared/types.js';

export type AgentRunProfileTools = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  [key: string]: unknown;
};

export type AgentRunProfileRow = {
  profile_id: string;
  name: string;
  description: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permission_mode: string;
  tools_json: string;
  permission_intent: string;
  created_at: string;
  updated_at: string;
};

export type AgentRunProfile = Omit<AgentRunProfileRow, 'tools_json'> & {
  tools: AgentRunProfileTools;
};

export type CreateAgentRunProfileInput = {
  name: string;
  description?: string;
  provider: LLMProvider | string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string;
  tools?: AgentRunProfileTools;
  permissionIntent?: string;
};

export type UpdateAgentRunProfileInput = {
  name?: string;
  description?: string;
  provider?: LLMProvider | string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string;
  tools?: AgentRunProfileTools;
  permissionIntent?: string;
};

function parseTools(toolsJson: string): AgentRunProfileTools {
  try {
    const parsed = JSON.parse(toolsJson);
    return parsed && typeof parsed === 'object' ? (parsed as AgentRunProfileTools) : {};
  } catch {
    return {};
  }
}

function mapProfile(row: AgentRunProfileRow): AgentRunProfile {
  const { tools_json, ...rest } = row;
  return {
    ...rest,
    description: rest.description ?? '',
    model: rest.model ?? null,
    effort: rest.effort ?? null,
    permission_mode: rest.permission_mode || 'default',
    permission_intent: rest.permission_intent ?? '',
    tools: parseTools(tools_json),
  };
}

/** Lightweight plain-English → allow/deny compiler for Auto-mode profiles. */
export function compilePermissionIntent(intent: string): {
  allowedCommands: string[];
  disallowedCommands: string[];
  suggestedMode: string | null;
} {
  const text = intent.toLowerCase();
  const allowed: string[] = [];
  const disallowed: string[] = [];
  let suggestedMode: string | null = null;

  const addAllow = (rule: string) => {
    if (!allowed.includes(rule)) allowed.push(rule);
  };
  const addDeny = (rule: string) => {
    if (!disallowed.includes(rule)) disallowed.push(rule);
  };

  if (/\bgit\b/.test(text)) {
    addAllow('Bash(git*)');
    addAllow('Bash(git status*)');
    addAllow('Bash(git diff*)');
    addAllow('Bash(git log*)');
  }
  if (/\bnpm\b|\bpnpm\b|\byarn\b|\bnode\b/.test(text)) {
    addAllow('Bash(npm*)');
    addAllow('Bash(node*)');
    addAllow('Bash(pnpm*)');
    addAllow('Bash(yarn*)');
  }
  if (/\btest(s|ing)?\b|\bpytest\b|\bjest\b|\bvitest\b/.test(text)) {
    addAllow('Bash(npm test*)');
    addAllow('Bash(npx*)');
    addAllow('Bash(pytest*)');
    addAllow('Bash(vitest*)');
  }
  if (/\bread(-|\s)?only\b|\bread\b/.test(text)) {
    addAllow('Read');
    addAllow('Glob');
    addAllow('Grep');
    addAllow('Bash(ls*)');
    addAllow('Bash(cat*)');
  }
  if (/\bwrite\b|\bedit\b|\bfile(s)?\b/.test(text) && !/\bread(-|\s)?only\b/.test(text)) {
    addAllow('Write');
    addAllow('Edit');
    addAllow('MultiEdit');
  }
  if (
    /\bno\s+network\b|\boffline\b|\bdeny\s+network\b/.test(text) ||
    (/\b(deny|no|block)\b/.test(text) && /\bnetwork\b/.test(text))
  ) {
    addDeny('Bash(curl*)');
    addDeny('Bash(wget*)');
    addDeny('WebFetch');
    addDeny('WebSearch');
  }
  if (
    /\bno\s+rm\b|\bdeny\s+rm\b|\bno\s+delete\b/.test(text) ||
    (/\b(deny|no|block)\b/.test(text) && /\brm\b/.test(text))
  ) {
    addDeny('Bash(rm*)');
  }
  if (/\bbypass\b|\bunrestricted\b|\bfull\s+access\b/.test(text)) {
    suggestedMode = 'bypassPermissions';
  } else if (/\baccept\s+edits?\b|\bauto\s+accept\b/.test(text)) {
    suggestedMode = 'acceptEdits';
  } else if (/\bplan\b/.test(text)) {
    suggestedMode = 'plan';
  } else if (/\bauto\b/.test(text) && allowed.length > 0) {
    // Auto with explicit allows: keep default mode but pre-allow tools.
    suggestedMode = 'default';
  }

  return { allowedCommands: allowed, disallowedCommands: disallowed, suggestedMode };
}

const SEED_PROFILES: CreateAgentRunProfileInput[] = [
  {
    name: 'Claude Balanced',
    description: 'Default Claude model with medium effort and accept-edits.',
    provider: 'claude',
    effort: 'medium',
    permissionMode: 'acceptEdits',
  },
  {
    name: 'Claude High Effort',
    description: 'Claude with high reasoning effort for harder implement work.',
    provider: 'claude',
    effort: 'high',
    permissionMode: 'acceptEdits',
    permissionIntent: 'Allow git, npm, read and write project files; deny rm and network downloads',
  },
  {
    name: 'Grok Low Effort',
    description: 'Fast Grok runs for lighter tasks and reviews.',
    provider: 'grok',
    effort: 'low',
    permissionMode: 'default',
    permissionIntent: 'Allow git status/diff, read files; deny rm and sudo',
  },
  {
    name: 'Strict Review',
    description: 'Read-focused review agent — inspect diffs without broad write access.',
    provider: 'claude',
    effort: 'medium',
    permissionMode: 'plan',
    permissionIntent: 'Read-only: git status/diff/log, read files; deny rm and network',
  },
];

export const agentRunProfilesDb = {
  list(): AgentRunProfile[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT * FROM agent_run_profiles ORDER BY name COLLATE NOCASE ASC`)
      .all() as AgentRunProfileRow[];
    return rows.map(mapProfile);
  },

  get(profileId: string): AgentRunProfile | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM agent_run_profiles WHERE profile_id = ?`)
      .get(profileId) as AgentRunProfileRow | undefined;
    return row ? mapProfile(row) : null;
  },

  create(input: CreateAgentRunProfileInput): AgentRunProfile {
    const db = getConnection();
    const profileId = randomUUID();
    const tools = input.tools ?? {};
    // If plain-English intent is provided without tools, compile a starting set.
    let permissionMode = input.permissionMode ?? 'default';
    let toolsJson = tools;
    if (input.permissionIntent?.trim() && !tools.allowedCommands?.length && !tools.disallowedCommands?.length) {
      const compiled = compilePermissionIntent(input.permissionIntent);
      toolsJson = {
        allowedCommands: compiled.allowedCommands,
        disallowedCommands: compiled.disallowedCommands,
      };
      if (compiled.suggestedMode && !input.permissionMode) {
        permissionMode = compiled.suggestedMode;
      }
    }

    db.prepare(
      `INSERT INTO agent_run_profiles (
         profile_id, name, description, provider, model, effort,
         permission_mode, tools_json, permission_intent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      profileId,
      input.name.trim(),
      input.description ?? '',
      input.provider,
      input.model ?? null,
      input.effort ?? null,
      permissionMode,
      JSON.stringify(toolsJson),
      input.permissionIntent ?? '',
    );
    return agentRunProfilesDb.get(profileId)!;
  },

  update(profileId: string, patch: UpdateAgentRunProfileInput): AgentRunProfile | null {
    const existing = agentRunProfilesDb.get(profileId);
    if (!existing) {
      return null;
    }

    let tools = patch.tools !== undefined ? patch.tools : existing.tools;
    let permissionMode = patch.permissionMode ?? existing.permission_mode;
    const permissionIntent =
      patch.permissionIntent !== undefined ? patch.permissionIntent : existing.permission_intent;

    // Recompile when intent changes and tools were not explicitly patched.
    if (patch.permissionIntent !== undefined && patch.tools === undefined && permissionIntent.trim()) {
      const compiled = compilePermissionIntent(permissionIntent);
      tools = {
        allowedCommands: compiled.allowedCommands,
        disallowedCommands: compiled.disallowedCommands,
      };
      if (compiled.suggestedMode && patch.permissionMode === undefined) {
        permissionMode = compiled.suggestedMode;
      }
    }

    const db = getConnection();
    db.prepare(
      `UPDATE agent_run_profiles SET
         name = ?, description = ?, provider = ?, model = ?, effort = ?,
         permission_mode = ?, tools_json = ?, permission_intent = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ?`,
    ).run(
      (patch.name ?? existing.name).trim(),
      patch.description !== undefined ? patch.description : existing.description,
      patch.provider ?? existing.provider,
      patch.model !== undefined ? patch.model : existing.model,
      patch.effort !== undefined ? patch.effort : existing.effort,
      permissionMode,
      JSON.stringify(tools ?? {}),
      permissionIntent,
      profileId,
    );
    return agentRunProfilesDb.get(profileId);
  },

  delete(profileId: string): boolean {
    const db = getConnection();
    const result = db.prepare(`DELETE FROM agent_run_profiles WHERE profile_id = ?`).run(profileId);
    return result.changes > 0;
  },

  /** Seed starter profiles when the table is empty (first use). */
  ensureSeedProfiles(): AgentRunProfile[] {
    const existing = agentRunProfilesDb.list();
    if (existing.length > 0) {
      return existing;
    }
    for (const seed of SEED_PROFILES) {
      agentRunProfilesDb.create(seed);
    }
    return agentRunProfilesDb.list();
  },
};
