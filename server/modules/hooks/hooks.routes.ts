import express from 'express';

import { hooksService } from '@/modules/hooks/hooks.service.js';
import { isHookEvent, type CloudcliHookCreateInput, type CloudcliHookUpdateInput } from '@/modules/hooks/hooks.types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

function readPathParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new AppError('Expected a string', { code: 'HOOK_INVALID_INPUT', statusCode: 400 });
  }
  return value;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new AppError('Expected a boolean', { code: 'HOOK_INVALID_INPUT', statusCode: 400 });
  }
  return value;
}

function parseBody(body: Record<string, unknown>, partial: boolean): CloudcliHookCreateInput | CloudcliHookUpdateInput {
  const name = readOptionalString(body.name);
  const instruction = readOptionalString(body.instruction);
  const provider = readOptionalString(body.provider);
  const enabled = readOptionalBoolean(body.enabled);
  let event = body.event;
  if (event !== undefined && event !== null && event !== '') {
    if (!isHookEvent(event)) {
      throw new AppError('event must be session_start', { code: 'HOOK_EVENT_INVALID', statusCode: 400 });
    }
  } else {
    event = undefined;
  }

  if (!partial) {
    if (!name?.trim()) {
      throw new AppError('name is required', { code: 'HOOK_NAME_REQUIRED', statusCode: 400 });
    }
    if (!instruction?.trim()) {
      throw new AppError('instruction is required', { code: 'HOOK_INSTRUCTION_REQUIRED', statusCode: 400 });
    }
  }

  return {
    name,
    instruction,
    provider,
    enabled,
    event: event as CloudcliHookCreateInput['event'],
  };
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(createApiSuccessResponse({ hooks: hooksService.list() }));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parseBody(body, false) as CloudcliHookCreateInput;
    const hook = hooksService.create(input);
    res.status(201).json(createApiSuccessResponse({ hook }));
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = readPathParam(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hook = hooksService.update(id, parseBody(body, true));
    res.json(createApiSuccessResponse({ hook }));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = readPathParam(req.params.id);
    hooksService.remove(id);
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);

export default router;
