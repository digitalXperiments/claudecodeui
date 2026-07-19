import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import type { ProviderSkillCreateEntry } from '@/shared/types.js';
import {
  readOptionalString,
  readProviderSkillMarkdownDefinitionFromContent,
  AppError,
} from '@/shared/utils.js';

/**
 * Normalized, ready-to-write representation of one skill entry targeting a
 * specific skill root directory. Both the per-provider skills provider and the
 * cross-agent project skills service share this shape so validation and disk
 * layout stay identical no matter which writer installed the skill.
 */
export type PreparedSkillInstall = {
  skillDirectoryPath: string;
  skillPath: string;
  content: string;
  supportingFiles: Array<{
    targetPath: string;
    content: string | Buffer;
  }>;
  definition: { name: string; description: string };
  directoryName: string;
};

const stripMarkdownExtension = (value: string): string => value.replace(/\.md$/i, '');

export const normalizeSkillDirectoryName = (value: string): string => (
  value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '')
);

const resolveSkillSupportingFilePath = (
  skillDirectoryPath: string,
  relativePath: string,
  entryIndex: number,
): string => {
  const normalizedRelativePath = relativePath.trim().replace(/\\/g, '/');
  const pathSegments = normalizedRelativePath.split('/');
  if (
    !normalizedRelativePath
    || path.isAbsolute(normalizedRelativePath)
    || pathSegments.some((segment) => !segment || segment === '.' || segment === '..')
    || normalizedRelativePath.toLowerCase() === 'skill.md'
  ) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} includes an invalid supporting file path "${relativePath}".`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
  const resolvedFilePath = path.resolve(resolvedSkillDirectoryPath, ...pathSegments);
  if (!resolvedFilePath.startsWith(`${resolvedSkillDirectoryPath}${path.sep}`)) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} supporting files must stay inside the skill directory.`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  return resolvedFilePath;
};

/**
 * Validates and normalizes one skill entry into a {@link PreparedSkillInstall}
 * rooted at `rootDir`. `seenSkillPaths` is shared across entries in one request
 * so duplicate skill targets are rejected before anything is written.
 */
export const prepareSkillInstall = (
  rootDir: string,
  entry: ProviderSkillCreateEntry,
  index: number,
  seenSkillPaths: Set<string>,
): PreparedSkillInstall => {
  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  if (!content) {
    throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
      code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
      statusCode: 400,
    });
  }

  const fileNameFallback = readOptionalString(entry.fileName);
  const requestedDirectoryName = readOptionalString(entry.directoryName);
  const fallbackSkillName = normalizeSkillDirectoryName(
    requestedDirectoryName
      ?? (fileNameFallback ? stripMarkdownExtension(fileNameFallback) : `skill-${index + 1}`),
  );
  const definition = readProviderSkillMarkdownDefinitionFromContent(content, fallbackSkillName);
  const resolvedDirectoryName = normalizeSkillDirectoryName(
    requestedDirectoryName ?? definition.name,
  );

  if (!resolvedDirectoryName) {
    throw new AppError(`Skill entry ${index + 1} must include a valid skill name.`, {
      code: 'PROVIDER_SKILL_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const skillDirectoryPath = path.join(rootDir, resolvedDirectoryName);
  const skillPath = path.join(skillDirectoryPath, 'SKILL.md');
  const normalizedSkillPath = path.resolve(skillPath);
  if (seenSkillPaths.has(normalizedSkillPath)) {
    throw new AppError(`Duplicate skill target "${resolvedDirectoryName}" in one request.`, {
      code: 'PROVIDER_SKILL_DUPLICATE_TARGET',
      statusCode: 400,
    });
  }
  seenSkillPaths.add(normalizedSkillPath);

  const supportingFiles = (entry.files ?? []).map((file) => ({
    targetPath: resolveSkillSupportingFilePath(skillDirectoryPath, file.relativePath, index),
    content: file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : file.content,
  }));
  const seenSupportingPaths = new Set<string>();
  for (const file of supportingFiles) {
    if (seenSupportingPaths.has(file.targetPath)) {
      throw new AppError(`Skill entry ${index + 1} includes a duplicate supporting file path.`, {
        code: 'PROVIDER_SKILL_DUPLICATE_FILE',
        statusCode: 400,
      });
    }
    seenSupportingPaths.add(file.targetPath);
  }

  return {
    skillDirectoryPath,
    skillPath,
    content,
    supportingFiles,
    definition,
    directoryName: resolvedDirectoryName,
  };
};

/**
 * Writes a prepared skill to disk. The complete skill directory is replaced so
 * removed scripts or assets from a previous version do not remain stale.
 */
export const writeSkillInstall = async (install: PreparedSkillInstall): Promise<void> => {
  await rm(install.skillDirectoryPath, { recursive: true, force: true });
  await mkdir(install.skillDirectoryPath, { recursive: true });
  await writeFile(install.skillPath, `${install.content}\n`, 'utf8');
  for (const file of install.supportingFiles) {
    await mkdir(path.dirname(file.targetPath), { recursive: true });
    await writeFile(file.targetPath, file.content);
  }
};
