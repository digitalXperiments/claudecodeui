import path from 'node:path';
import { rm, stat } from 'node:fs/promises';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  normalizeSkillDirectoryName,
  prepareSkillInstall,
  writeSkillInstall,
} from '@/modules/providers/shared/skills/skills.materialize.js';
import type {
  LLMProvider,
  ProjectSkill,
  ProjectSkillCreateInput,
  ProjectSkillListOptions,
  ProjectSkillRemoveInput,
} from '@/shared/types.js';
import {
  AppError,
  findProviderSkillMarkdownFiles,
  readJsonConfig,
  readObjectRecord,
  readProviderSkillMarkdownDefinition,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * Cross-agent project skills.
 *
 * A project skill is authored once into a workspace's managed canonical folder
 * (`.cloudcli/skills/<name>`) and then fanned out into every installed agent's
 * project-scoped skill directory (for example `.claude/skills` and
 * `.agents/skills`) so any agent run in the workspace can use it. A manifest
 * (`.cloudcli/skills/.managed.json`) records which agent folders each skill was
 * written to, so removal is exact and hand-authored per-agent skills of the
 * same name are never clobbered.
 */

const MANAGED_DIR_SEGMENTS = ['.cloudcli', 'skills'] as const;
const MANIFEST_FILE_NAME = '.managed.json';

type ManifestEntry = {
  targets: string[];
  providers: LLMProvider[];
  updatedAt: string;
};

type Manifest = {
  skills: Record<string, ManifestEntry>;
};

const resolveWorkspacePath = (workspacePath: string): string => {
  const trimmed = (workspacePath ?? '').trim();
  if (!trimmed) {
    throw new AppError('workspacePath is required for project skills.', {
      code: 'PROJECT_SKILL_WORKSPACE_REQUIRED',
      statusCode: 400,
    });
  }

  return path.resolve(trimmed);
};

const getManagedRoot = (workspacePath: string): string =>
  path.join(workspacePath, ...MANAGED_DIR_SEGMENTS);

const getManifestPath = (workspacePath: string): string =>
  path.join(getManagedRoot(workspacePath), MANIFEST_FILE_NAME);

const isPathInsideRoot = (root: string, target: string): boolean => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot
    || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
};

const requireDirectoryName = (directoryName: string): string => {
  const normalized = normalizeSkillDirectoryName(directoryName ?? '');
  if (!normalized) {
    throw new AppError('Skill directoryName is required.', {
      code: 'PROJECT_SKILL_DIRECTORY_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

/**
 * Resolves the deduplicated set of writable project skill directories across
 * every installed agent, tracking which agents read each directory.
 */
type ResolvedTarget = { rootDir: string; providers: LLMProvider[] };

const resolveTargets = async (workspacePath: string): Promise<ResolvedTarget[]> => {
  const byRootDir = new Map<string, ResolvedTarget>();

  for (const provider of providerRegistry.listProviders()) {
    const source = await provider.skills.getProjectSkillTarget(workspacePath);
    if (!source) {
      continue;
    }

    const key = path.resolve(source.rootDir);
    const existing = byRootDir.get(key);
    if (existing) {
      if (!existing.providers.includes(provider.id)) {
        existing.providers.push(provider.id);
      }
      continue;
    }

    byRootDir.set(key, { rootDir: source.rootDir, providers: [provider.id] });
  }

  return [...byRootDir.values()];
};

const readManifest = async (workspacePath: string): Promise<Manifest> => {
  const raw = await readJsonConfig(getManifestPath(workspacePath));
  const skills = readObjectRecord(raw.skills) ?? {};
  const normalized: Record<string, ManifestEntry> = {};

  for (const [name, value] of Object.entries(skills)) {
    const entry = readObjectRecord(value);
    if (!entry) {
      continue;
    }

    normalized[name] = {
      targets: Array.isArray(entry.targets)
        ? entry.targets.filter((item): item is string => typeof item === 'string')
        : [],
      providers: Array.isArray(entry.providers)
        ? entry.providers.filter((item): item is LLMProvider => typeof item === 'string') as LLMProvider[]
        : [],
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    };
  }

  return { skills: normalized };
};

const writeManifest = async (workspacePath: string, manifest: Manifest): Promise<void> => {
  await writeJsonConfig(getManifestPath(workspacePath), { skills: manifest.skills });
};

const directoryExists = async (directoryPath: string): Promise<boolean> => {
  try {
    const stats = await stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

export const projectSkillsService = {
  /**
   * Lists managed project skills authored for a workspace.
   */
  async listProjectSkills(options: ProjectSkillListOptions): Promise<ProjectSkill[]> {
    const workspacePath = resolveWorkspacePath(options.workspacePath);
    const managedRoot = getManagedRoot(workspacePath);
    const manifest = await readManifest(workspacePath);

    const skillFiles = await findProviderSkillMarkdownFiles(managedRoot, { recursive: false });
    const skills: ProjectSkill[] = [];

    for (const skillPath of skillFiles) {
      try {
        const definition = await readProviderSkillMarkdownDefinition(skillPath);
        const directoryName = path.basename(path.dirname(skillPath));
        const manifestEntry = manifest.skills[directoryName];

        skills.push({
          name: definition.name,
          description: definition.description,
          directoryName,
          sourcePath: skillPath,
          providers: manifestEntry?.providers ?? [],
          conflicts: [],
        });
      } catch {
        // A malformed managed skill should not hide the rest of the list.
      }
    }

    return skills.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
  },

  /**
   * Installs one or more project skills and fans them out to every agent's
   * project skill directory. A target agent folder is skipped when a
   * non-managed skill of the same name already exists there.
   */
  async addProjectSkills(input: ProjectSkillCreateInput): Promise<ProjectSkill[]> {
    const workspacePath = resolveWorkspacePath(input.workspacePath);
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new AppError('At least one skill entry is required.', {
        code: 'PROJECT_SKILLS_REQUIRED',
        statusCode: 400,
      });
    }

    const managedRoot = getManagedRoot(workspacePath);
    const targets = await resolveTargets(workspacePath);
    const manifest = await readManifest(workspacePath);

    // Validate every entry against the canonical root before touching disk so a
    // bad entry cannot leave a workspace half-written.
    const canonicalSeen = new Set<string>();
    const canonicalInstalls = input.entries.map((entry, index) =>
      prepareSkillInstall(managedRoot, entry, index, canonicalSeen));

    const results: ProjectSkill[] = [];

    for (const [index, canonicalInstall] of canonicalInstalls.entries()) {
      const entry = input.entries[index];
      const { directoryName } = canonicalInstall;

      await writeSkillInstall(canonicalInstall);

      const previousTargets = new Set(manifest.skills[directoryName]?.targets ?? []);
      const writtenTargets: string[] = [];
      const coveredProviders: LLMProvider[] = [];
      const conflictProviders: LLMProvider[] = [];

      for (const target of targets) {
        const resolvedRootDir = path.resolve(target.rootDir);
        const targetSkillDir = path.join(target.rootDir, directoryName);
        const alreadyExists = await directoryExists(targetSkillDir);
        const ownedByUs = previousTargets.has(resolvedRootDir);

        if (alreadyExists && !ownedByUs) {
          conflictProviders.push(...target.providers);
          continue;
        }

        const targetSeen = new Set<string>();
        const targetInstall = prepareSkillInstall(target.rootDir, entry, index, targetSeen);
        await writeSkillInstall(targetInstall);
        writtenTargets.push(resolvedRootDir);
        coveredProviders.push(...target.providers);
      }

      manifest.skills[directoryName] = {
        targets: writtenTargets,
        providers: coveredProviders,
        updatedAt: new Date().toISOString(),
      };

      results.push({
        name: canonicalInstall.definition.name,
        description: canonicalInstall.definition.description,
        directoryName,
        sourcePath: canonicalInstall.skillPath,
        providers: coveredProviders,
        conflicts: conflictProviders,
      });
    }

    await writeManifest(workspacePath, manifest);
    return results;
  },

  /**
   * Removes a project skill from the canonical folder and every agent folder it
   * was written to.
   */
  async removeProjectSkill(
    input: ProjectSkillRemoveInput,
  ): Promise<{ removed: boolean; directoryName: string; providers: LLMProvider[] }> {
    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const directoryName = requireDirectoryName(input.directoryName);
    const managedRoot = getManagedRoot(workspacePath);
    const manifest = await readManifest(workspacePath);
    const manifestEntry = manifest.skills[directoryName];

    // Fall back to the currently resolved agent folders when the manifest has no
    // record, so a skill written before the manifest existed can still be torn
    // down. Only directories that resolve inside a known target root are removed.
    const targetRootDirs = manifestEntry?.targets?.length
      ? manifestEntry.targets
      : (await resolveTargets(workspacePath)).map((target) => path.resolve(target.rootDir));

    for (const rootDir of targetRootDirs) {
      const targetSkillDir = path.join(rootDir, directoryName);
      if (!isPathInsideRoot(rootDir, targetSkillDir) || path.resolve(targetSkillDir) === path.resolve(rootDir)) {
        continue;
      }

      await rm(targetSkillDir, { recursive: true, force: true });
    }

    const canonicalSkillDir = path.join(managedRoot, directoryName);
    if (!isPathInsideRoot(managedRoot, canonicalSkillDir) || path.resolve(canonicalSkillDir) === path.resolve(managedRoot)) {
      throw new AppError('Skill directory must stay inside the managed skill root.', {
        code: 'PROJECT_SKILL_DIRECTORY_INVALID',
        statusCode: 400,
      });
    }

    const removed = await directoryExists(canonicalSkillDir);
    if (removed) {
      await rm(canonicalSkillDir, { recursive: true, force: true });
    }

    const providers = manifestEntry?.providers ?? [];
    if (manifest.skills[directoryName]) {
      delete manifest.skills[directoryName];
      await writeManifest(workspacePath, manifest);
    }

    return { removed, directoryName, providers };
  },
};
