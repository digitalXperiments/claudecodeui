import express, { type Request, type Response } from 'express';

import { obsidianSettingsService } from '@/modules/providers/services/obsidian-settings.service.js';
import { projectMemoryService } from '@/modules/providers/services/project-memory.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const readRequiredString = (value: unknown, name: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new AppError(`${name} is required.`, {
      code: 'PROJECT_MEMORY_PARAMETER_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

const readWorkspaceQuery = (value: unknown): string => {
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return readRequiredString(value[0], 'workspacePath');
  }

  return readRequiredString(value, 'workspacePath');
};

// ----------------- Global Obsidian settings -----------------
router.get(
  '/settings',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ settings: obsidianSettingsService.getStatus() }));
  }),
);

router.put(
  '/settings',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const settings = obsidianSettingsService.saveSettings({
      vaultPath: typeof body.vaultPath === 'string' ? body.vaultPath : undefined,
      restProtocol: body.restProtocol === 'http' || body.restProtocol === 'https' ? body.restProtocol : undefined,
      restHost: typeof body.restHost === 'string' ? body.restHost : undefined,
      restPort:
        typeof body.restPort === 'number'
          ? body.restPort
          : typeof body.restPort === 'string' && body.restPort.trim()
            ? Number(body.restPort)
            : undefined,
      restApiKey: typeof body.restApiKey === 'string' ? body.restApiKey : undefined,
    });
    res.json(createApiSuccessResponse({ settings }));
  }),
);

// ----------------- Per-project memory -----------------
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const workspacePath = readWorkspaceQuery(req.query.workspacePath);
    const status = await projectMemoryService.getMemoryStatus(workspacePath);
    res.json(createApiSuccessResponse({ status }));
  }),
);

router.put(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspacePath = readRequiredString(body.workspacePath, 'workspacePath');
    const vaultFolder = typeof body.vaultFolder === 'string' ? body.vaultFolder : '';
    const result = await projectMemoryService.enableMemory({
      workspacePath,
      vaultFolder,
      enabled: true,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/rescaffold',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspacePath = readRequiredString(body.workspacePath, 'workspacePath');
    const scaffold = await projectMemoryService.rescaffold(workspacePath);
    res.json(createApiSuccessResponse({ scaffold }));
  }),
);

router.delete(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const workspacePath = readWorkspaceQuery(req.query.workspacePath);
    const result = await projectMemoryService.disableMemory(workspacePath);
    res.json(createApiSuccessResponse(result));
  }),
);

export default router;
