import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

export type AgentRunProfileTools = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
};

/** Swarm roster roles a profile may be auto-selected for by the orchestrator. */
export const SWARM_PROFILE_ROLES = ['explorer', 'implementer', 'reviewer', 'tester', 'security', 'docs'] as const;

export type SwarmProfileRole = (typeof SWARM_PROFILE_ROLES)[number];

/**
 * Capability tier, weakest → strongest. The orchestrator reads this as a
 * quantitative signal when matching a seat to a step's difficulty.
 */
export const SWARM_PROFILE_LEVELS = ['basic', 'medium', 'advanced'] as const;

export type SwarmProfileLevel = (typeof SWARM_PROFILE_LEVELS)[number];

export type AgentRunProfile = {
  profile_id: string;
  name: string;
  description: string;
  provider: LLMProvider | string;
  model: string | null;
  effort: string | null;
  permission_mode: string;
  tools: AgentRunProfileTools;
  permission_intent: string;
  swarm_roles: SwarmProfileRole[];
  swarm_level: SwarmProfileLevel;
  /** false = kept for explicit use, but excluded from automatic seat selection. */
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentRunProfileInput = {
  name: string;
  description?: string;
  provider: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string;
  tools?: AgentRunProfileTools;
  permissionIntent?: string;
  swarmRoles?: SwarmProfileRole[];
  swarmLevel?: SwarmProfileLevel;
  enabled?: boolean;
};

const BASE = '/api/agent-profiles';

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorObj = (payload as { error?: unknown })?.error;
    const message =
      (errorObj && typeof errorObj === 'object' && typeof (errorObj as { message?: string }).message === 'string'
        ? (errorObj as { message: string }).message
        : typeof errorObj === 'string'
          ? errorObj
          : typeof (payload as { message?: string })?.message === 'string'
            ? (payload as { message: string }).message
            : null) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export const agentProfilesApi = {
  async list(filter?: {
    swarmRole?: SwarmProfileRole;
    minSwarmLevel?: SwarmProfileLevel;
  }): Promise<AgentRunProfile[]> {
    const params = new URLSearchParams();
    if (filter?.swarmRole) params.set('swarmRole', filter.swarmRole);
    if (filter?.minSwarmLevel) params.set('minSwarmLevel', filter.minSwarmLevel);
    const query = params.toString();
    const res = await authenticatedFetch(query ? `${BASE}?${query}` : BASE);
    const data = await parse<{ profiles?: AgentRunProfile[] }>(res);
    return Array.isArray(data.profiles) ? data.profiles : [];
  },

  async create(input: AgentRunProfileInput): Promise<AgentRunProfile> {
    const res = await authenticatedFetch(BASE, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parse<{ profile: AgentRunProfile }>(res);
    return data.profile;
  },

  async update(profileId: string, input: Partial<AgentRunProfileInput>): Promise<AgentRunProfile> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(profileId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const data = await parse<{ profile: AgentRunProfile }>(res);
    return data.profile;
  },

  async remove(profileId: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(profileId)}`, {
      method: 'DELETE',
    });
    await parse(res);
  },

  async compilePermissions(intent: string): Promise<{
    allowedCommands: string[];
    disallowedCommands: string[];
    suggestedMode: string | null;
    source?: 'claude' | 'fallback';
    note?: string;
  }> {
    const res = await authenticatedFetch(`${BASE}/compile-permissions`, {
      method: 'POST',
      body: JSON.stringify({ intent }),
    });
    return parse(res);
  },
};
