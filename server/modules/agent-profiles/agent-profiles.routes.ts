import express from 'express';

import {
  agentRunProfilesDb,
  type CreateAgentRunProfileInput,
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
  'agy',
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

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const profiles = agentRunProfilesDb.ensureSeedProfiles();
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
