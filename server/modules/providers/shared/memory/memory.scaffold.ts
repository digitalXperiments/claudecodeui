import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/**
 * Scaffolds the full "second brain" skeleton for a project inside the Obsidian
 * vault. Writes markdown directly to disk (the vault is just a folder), so it
 * works whether or not Obsidian is running. Idempotent: existing files are left
 * untouched, so re-scaffolding never clobbers accumulated notes.
 */

type ScaffoldInput = {
  vaultPath: string;
  vaultFolder: string;
  projectName: string;
};

export type ScaffoldResult = {
  targetDir: string;
  created: string[];
  skipped: string[];
};

/**
 * Resolves and validates the project folder inside the vault, refusing paths
 * that would escape the vault root (e.g. via `..`).
 */
export const resolveVaultTargetDir = (vaultPath: string, vaultFolder: string): string => {
  const resolvedVault = path.resolve(vaultPath);
  const resolvedTarget = path.resolve(resolvedVault, vaultFolder);
  if (
    resolvedTarget !== resolvedVault &&
    !resolvedTarget.startsWith(`${resolvedVault}${path.sep}`)
  ) {
    throw new AppError('vaultFolder must stay inside the vault.', {
      code: 'MEMORY_VAULT_FOLDER_INVALID',
      statusCode: 400,
    });
  }

  return resolvedTarget;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const buildSkeleton = (projectName: string, vaultFolder: string): Record<string, string> => {
  const title = projectName || path.basename(vaultFolder) || 'Project';
  return {
    '00-Overview.md': `# ${title} — Overview

> Canonical summary of this project. Keep this current — it is the first note
> every agent reads.

## Goals

-

## Constraints

-

## Stack

-

## Key links

- [[Index]]
`,
    'Index.md': `# ${title} — Index (Map of Content)

The hub of this project's second brain. Link every important note here.

## Core

- [[00-Overview]]

## Decisions

_(link notes from Decisions/ here)_

## Entities

_(link notes from Entities/ here)_

## Sessions

_(dated logs accumulate under Sessions/)_
`,
    'Decisions/.keep': '',
    'Entities/.keep': '',
    'Sessions/.keep': '',
  };
};

export const scaffoldVault = async (input: ScaffoldInput): Promise<ScaffoldResult> => {
  const targetDir = resolveVaultTargetDir(input.vaultPath, input.vaultFolder);
  const skeleton = buildSkeleton(input.projectName, input.vaultFolder);

  const created: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, content] of Object.entries(skeleton)) {
    const filePath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });

    if (await fileExists(filePath)) {
      skipped.push(relativePath);
      continue;
    }

    await writeFile(filePath, content, 'utf8');
    created.push(relativePath);
  }

  return { targetDir, created, skipped };
};
