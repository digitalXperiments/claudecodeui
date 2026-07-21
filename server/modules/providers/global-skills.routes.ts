import express, { type Request, type Response } from 'express';

import { globalSkillsService } from '@/modules/providers/services/global-skills.service.js';
import { projectMemoryService } from '@/modules/providers/services/project-memory.service.js';
import { MEMORY_SKILL_DIRECTORY_NAME } from '@/modules/providers/shared/memory/memory-skill.template.js';
import type {
  GlobalSkillCreateInput,
  ProviderSkillCreateEntry,
  ProviderSkillCreateFile,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const readRequiredString = (value: unknown, name: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new AppError(`${name} is required.`, {
      code: 'GLOBAL_SKILL_PARAMETER_REQUIRED',
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

const parseGlobalSkillCreatePayload = (payload: unknown): GlobalSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
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
      code: 'GLOBAL_SKILLS_REQUIRED',
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

  return { entries };
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

// ----------------- Global skills routes -----------------
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const skills = await globalSkillsService.listGlobalSkills();
    res.json(createApiSuccessResponse({ skills }));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseGlobalSkillCreatePayload(req.body);
    const skills = await globalSkillsService.addGlobalSkills(input);
    res.json(createApiSuccessResponse({ skills }));
  }),
);

router.delete(
  '/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await globalSkillsService.removeGlobalSkill({
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/:directoryName/content',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await globalSkillsService.getGlobalSkillContent({
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/:directoryName/content',
  asyncHandler(async (req: Request, res: Response) => {
    const directoryName = readPathParam(req.params.directoryName, 'directoryName');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = readRequiredString(body.content, 'content');

    const result = await globalSkillsService.updateGlobalSkillContent({ directoryName, content });

    // Saving the memory template re-renders the skill for every memory-enabled
    // project so the new contract reaches agents on their next run.
    let resync: Awaited<ReturnType<typeof projectMemoryService.resyncMemorySkill>> | null = null;
    if (directoryName === MEMORY_SKILL_DIRECTORY_NAME) {
      resync = await projectMemoryService.resyncMemorySkill();
    }

    res.json(createApiSuccessResponse({ ...result, resync }));
  }),
);

export default router;
