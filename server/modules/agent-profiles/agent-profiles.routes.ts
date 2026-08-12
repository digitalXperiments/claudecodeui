import express from 'express';

import {
  agentRunProfilesDb,
  isSwarmProfileLevel,
  isSwarmProfileRole,
  SWARM_PROFILE_LEVELS,
  SWARM_PROFILE_ROLES,
  type CreateAgentRunProfileInput,
  type SwarmProfileLevel,
  type SwarmProfileRole,
  type UpdateAgentRunProfileInput,
} from '@/modules/database/index.js';
import { compilePermissionsWithClaude } from '@/modules/agent-profiles/compile-permissions-claude.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';

const KNOWN_PROVIDERS: readonly LLMProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'pi',
];

const router = express.Router();

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function validateProvider(value: unknown): string {
  const provider = readString(value).trim();
  if (!KNOWN_PROVIDERS.includes(provider as LLMProvider)) {
    throw new AppError(`Invalid provider: ${provider || '(empty)'}`, {
      code: 'AGENT_PROFILE_INVALID_PROVIDER',
      statusCode: 400,
    });
  }
  return provider;
}

function parseTools(value: unknown): CreateAgentRunProfileInput['tools'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new AppError('tools must be an object', {
      code: 'AGENT_PROFILE_INVALID_TOOLS',
      statusCode: 400,
    });
  }
  const tools = value as Record<string, unknown>;
  const allowed = Array.isArray(tools.allowedCommands)
    ? tools.allowedCommands.filter((v): v is string => typeof v === 'string')
    : undefined;
  const disallowed = Array.isArray(tools.disallowedCommands)
    ? tools.disallowedCommands.filter((v): v is string => typeof v === 'string')
    : undefined;
  return { allowedCommands: allowed, disallowedCommands: disallowed };
}

/** Validates a swarmRoles payload: must be an array of known role strings. */
function parseSwarmRoles(value: unknown): SwarmProfileRole[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('swarmRoles must be an array', {
      code: 'AGENT_PROFILE_INVALID_SWARM_ROLES',
      statusCode: 400,
    });
  }
  const invalid = value.filter((role) => !isSwarmProfileRole(role));
  if (invalid.length > 0) {
    throw new AppError(
      `Invalid swarm role(s): ${invalid.map(String).join(', ')}. Valid roles: ${SWARM_PROFILE_ROLES.join(', ')}`,
      {
        code: 'AGENT_PROFILE_INVALID_SWARM_ROLES',
        statusCode: 400,
      },
    );
  }
  return [...new Set(value as SwarmProfileRole[])];
}

/** Validates an enabled payload: must be a boolean when present. */
function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AppError('enabled must be a boolean', {
      code: 'AGENT_PROFILE_INVALID_ENABLED',
      statusCode: 400,
    });
  }
  return value;
}

/** Validates a swarmLevel payload: one of basic | medium | advanced. */
function parseSwarmLevel(value: unknown): SwarmProfileLevel | undefined {
  if (value === undefined) return undefined;
  if (!isSwarmProfileLevel(value)) {
    throw new AppError(
      `Invalid swarm level: ${String(value) || '(empty)'}. Valid levels: ${SWARM_PROFILE_LEVELS.join(', ')}`,
      {
        code: 'AGENT_PROFILE_INVALID_SWARM_LEVEL',
        statusCode: 400,
      },
    );
  }
  return value;
}

function validateSwarmLevelFilter(value: unknown): SwarmProfileLevel {
  const level = readString(value).trim();
  if (!isSwarmProfileLevel(level)) {
    throw new AppError(
      `Invalid minSwarmLevel filter: ${level || '(empty)'}. Valid levels: ${SWARM_PROFILE_LEVELS.join(', ')}`,
      {
        code: 'AGENT_PROFILE_INVALID_SWARM_LEVEL',
        statusCode: 400,
      },
    );
  }
  return level;
}

function validateSwarmRoleFilter(value: unknown): SwarmProfileRole {
  const role = readString(value).trim();
  if (!isSwarmProfileRole(role)) {
    throw new AppError(
      `Invalid swarmRole filter: ${role || '(empty)'}. Valid roles: ${SWARM_PROFILE_ROLES.join(', ')}`,
      {
        code: 'AGENT_PROFILE_INVALID_SWARM_ROLES',
        statusCode: 400,
      },
    );
  }
  return role;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    agentRunProfilesDb.ensureSeedProfiles();
    const swarmRoleParam = req.query.swarmRole;
    const minLevelParam = req.query.minSwarmLevel;
    const profiles = agentRunProfilesDb.list({
      swarmRole: swarmRoleParam === undefined ? undefined : validateSwarmRoleFilter(swarmRoleParam),
      minSwarmLevel:
        minLevelParam === undefined ? undefined : validateSwarmLevelFilter(minLevelParam),
    });
    res.json({ success: true, profiles });
  }),
);

/** Preview plain-English permissions without saving a profile (Claude by default). */
router.post(
  '/compile-permissions',
  asyncHandler(async (req, res) => {
    const intent = readString((req.body as Record<string, unknown>)?.intent).trim();
    if (!intent) {
      throw new AppError('intent is required', {
        code: 'AGENT_PROFILE_INTENT_REQUIRED',
        statusCode: 400,
      });
    }
    const compiled = await compilePermissionsWithClaude(intent);
    res.json({ success: true, ...compiled });
  }),
);

router.get(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const profile = agentRunProfilesDb.get(readString(req.params.profileId));
    if (!profile) {
      throw new AppError('Profile not found', {
        code: 'AGENT_PROFILE_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true, profile });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = readString(body.name).trim();
    if (!name) {
      throw new AppError('name is required', {
        code: 'AGENT_PROFILE_NAME_REQUIRED',
        statusCode: 400,
      });
    }
    const input: CreateAgentRunProfileInput = {
      name,
      description: readOptionalString(body.description),
      provider: validateProvider(body.provider),
      model: readNullableString(body.model),
      effort: readNullableString(body.effort),
      permissionMode: readOptionalString(body.permissionMode) ?? readOptionalString(body.permission_mode),
      tools: parseTools(body.tools),
      permissionIntent:
        readOptionalString(body.permissionIntent) ?? readOptionalString(body.permission_intent),
      swarmRoles: parseSwarmRoles(body.swarmRoles ?? body.swarm_roles),
      swarmLevel: parseSwarmLevel(body.swarmLevel ?? body.swarm_level),
      enabled: parseEnabled(body.enabled),
    };
    const profile = agentRunProfilesDb.create(input);
    res.status(201).json({ success: true, profile });
  }),
);

router.put(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const profileId = readString(req.params.profileId);
    const body = req.body as Record<string, unknown>;
    const patch: UpdateAgentRunProfileInput = {};
    if (body.name !== undefined) {
      const name = readString(body.name).trim();
      if (!name) {
        throw new AppError('name cannot be empty', {
          code: 'AGENT_PROFILE_NAME_REQUIRED',
          statusCode: 400,
        });
      }
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = readString(body.description);
    if (body.provider !== undefined) patch.provider = validateProvider(body.provider);
    if (body.model !== undefined) patch.model = readNullableString(body.model) ?? null;
    if (body.effort !== undefined) patch.effort = readNullableString(body.effort) ?? null;
    if (body.permissionMode !== undefined || body.permission_mode !== undefined) {
      patch.permissionMode =
        readOptionalString(body.permissionMode) ?? readOptionalString(body.permission_mode);
    }
    if (body.tools !== undefined) patch.tools = parseTools(body.tools);
    if (body.permissionIntent !== undefined || body.permission_intent !== undefined) {
      patch.permissionIntent =
        readOptionalString(body.permissionIntent) ?? readOptionalString(body.permission_intent) ?? '';
    }
    if (body.swarmRoles !== undefined || body.swarm_roles !== undefined) {
      patch.swarmRoles = parseSwarmRoles(body.swarmRoles ?? body.swarm_roles) ?? [];
    }
    if (body.swarmLevel !== undefined || body.swarm_level !== undefined) {
      patch.swarmLevel = parseSwarmLevel(body.swarmLevel ?? body.swarm_level);
    }
    if (body.enabled !== undefined) {
      patch.enabled = parseEnabled(body.enabled);
    }
    const profile = agentRunProfilesDb.update(profileId, patch);
    if (!profile) {
      throw new AppError('Profile not found', {
        code: 'AGENT_PROFILE_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true, profile });
  }),
);

router.delete(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const ok = agentRunProfilesDb.delete(readString(req.params.profileId));
    if (!ok) {
      throw new AppError('Profile not found', {
        code: 'AGENT_PROFILE_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true });
  }),
);

export default router;
