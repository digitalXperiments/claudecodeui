import express, { type Request, type Response } from 'express';

import { projectSkillsService } from '@/modules/providers/services/project-skills.service.js';
import type {
  ProjectSkillCreateInput,
  ProviderSkillCreateEntry,
  ProviderSkillCreateFile,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const readRequiredString = (value: unknown, name: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new AppError(`${name} is required.`, {
      code: 'PROJECT_SKILL_PARAMETER_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

const readOptionalString = (value: unknown): string | undefined => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : undefined;
};

const parseSkillFiles = (value: unknown, entryIndex: number): ProviderSkillCreateFile[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AppError(`Skill entry ${entryIndex + 1} files must be an array.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  return value.map((file, fileIndex) => {
    const record = (file ?? {}) as Record<string, unknown>;
    const relativePath = readOptionalString(record.relativePath);
    const content = typeof record.content === 'string' ? record.content : '';
    const encoding = record.encoding === 'utf8' ? 'utf8' : 'base64';

    if (!relativePath) {
      throw new AppError(
        `Skill entry ${entryIndex + 1} file ${fileIndex + 1} must include a relativePath.`,
        { code: 'PROVIDER_SKILL_FILE_PATH_INVALID', statusCode: 400 },
      );
    }

    return { relativePath, content, encoding } satisfies ProviderSkillCreateFile;
  });
};

const parseProjectSkillCreatePayload = (payload: unknown): ProjectSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const workspacePath = readRequiredString(body.workspacePath, 'workspacePath');
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROJECT_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      content,
      directoryName: readOptionalString(record.directoryName),
      fileName: readOptionalString(record.fileName),
      files: parseSkillFiles(record.files, index),
    } satisfies ProviderSkillCreateEntry;
  });

  return { workspacePath, entries };
};

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

// ----------------- Project skills routes -----------------
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const workspacePath = readRequiredString(req.query.workspacePath, 'workspacePath');
    const skills = await projectSkillsService.listProjectSkills({ workspacePath });
    res.json(createApiSuccessResponse({ workspacePath, skills }));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseProjectSkillCreatePayload(req.body);
    const skills = await projectSkillsService.addProjectSkills(input);
    res.json(createApiSuccessResponse({ workspacePath: input.workspacePath, skills }));
  }),
);

router.delete(
  '/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const workspacePath = readRequiredString(req.query.workspacePath, 'workspacePath');
    const result = await projectSkillsService.removeProjectSkill({
      workspacePath,
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

export default router;
