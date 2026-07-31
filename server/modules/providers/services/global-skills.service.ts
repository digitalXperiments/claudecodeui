import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  normalizeSkillDirectoryName,
  prepareSkillInstall,
  writeSkillInstall,
} from '@/modules/providers/shared/skills/skills.materialize.js';
import {
  MEMORY_SKILL_DIRECTORY_NAME,
  MEMORY_SKILL_TEMPLATE,
} from '@/modules/providers/shared/memory/memory-skill.template.js';
import type {
  GlobalSkill,
  GlobalSkillContentInput,
  GlobalSkillContentUpdateInput,
  GlobalSkillCreateInput,
  GlobalSkillRemoveInput,
  GlobalSkillScope,
  GlobalSkillScopeUpdateInput,
  LLMProvider,
  ProviderSkillCreateEntry,
  SkillContentResult,
} from '@/shared/types.js';
import {
  AppError,
  findProviderSkillMarkdownFiles,
  readJsonConfig,
  readObjectRecord,
  readProviderSkillMarkdownDefinition,
  readProviderSkillMarkdownDefinitionFromContent,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * Cross-agent global skills.
 *
 * A global skill is authored once into the machine-wide managed canonical folder
 * (`~/.cloudcli/skills/<name>`) and then fanned out according to its scope:
 * - `all` (the default): into every agent's user-scope skill directory (for
 *   example `~/.claude/skills` and `~/.kimi-code/skills`), so the skill applies
 *   to every project on this machine.
 * - `projects`: only into the selected workspaces' project-scope skill
 *   directories (for example `<workspace>/.claude/skills`).
 * A manifest (`~/.cloudcli/skills/.managed.json`) records which agent folders
 * each skill was written to, so removal and re-scoping are exact and
 * hand-authored per-agent skills of the same name are never clobbered.
 *
 * The reserved `project-memory` directory holds the editable memory skill
 * template. It is never fanned out; projects that enable memory render it with
 * their own vault folder (see project-memory.service).
 */

const MANAGED_DIR_SEGMENTS = ['.cloudcli', 'skills'] as const;
const MANIFEST_FILE_NAME = '.managed.json';

type ManifestEntry = {
  targets: string[];
  providers: LLMProvider[];
  updatedAt: string;
  scope?: GlobalSkillScope;
  projects?: string[];
};

type Manifest = {
  skills: Record<string, ManifestEntry>;
};

// Resolved at call time (not import time) so tests can patch os.homedir().
const getManagedRoot = (): string =>
  path.join(os.homedir(), ...MANAGED_DIR_SEGMENTS);

const getManifestPath = (): string =>
  path.join(getManagedRoot(), MANIFEST_FILE_NAME);

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
      code: 'GLOBAL_SKILL_DIRECTORY_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

const requireManagedDirectoryName = (directoryName: string): string => {
  const normalized = requireDirectoryName(directoryName);
  if (normalized === MEMORY_SKILL_DIRECTORY_NAME) {
    throw new AppError(
      'The memory skill template is managed. Edit it from the Global Skills tab instead of installing or removing it directly.',
      { code: 'GLOBAL_SKILL_MANAGED', statusCode: 400 },
    );
  }

  return normalized;
};

/**
 * Resolves the deduplicated set of writable user-scope skill directories across
 * every installed agent, tracking which agents read each directory. Agents
 * without a user-scope skill directory are reported as unsupported.
 */
type ResolvedTarget = { rootDir: string; providers: LLMProvider[] };

const resolveTargets = async (): Promise<{ targets: ResolvedTarget[]; unsupported: LLMProvider[] }> => {
  const byRootDir = new Map<string, ResolvedTarget>();
  const unsupported: LLMProvider[] = [];

  for (const provider of providerRegistry.listProviders()) {
    const source = await provider.skills.getGlobalSkillTarget();
    if (!source) {
      unsupported.push(provider.id);
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

  return { targets: [...byRootDir.values()], unsupported };
};

/**
 * Resolves the deduplicated set of writable project-scope skill directories
 * across every installed agent for the given workspaces. Agents without a
 * project-scope skill directory are reported as unsupported.
 */
const resolveProjectTargets = async (
  workspacePaths: string[],
): Promise<{ targets: ResolvedTarget[]; unsupported: LLMProvider[] }> => {
  const byRootDir = new Map<string, ResolvedTarget>();
  const supportedProviders = new Set<LLMProvider>();
  const allProviders = providerRegistry.listProviders();

  for (const workspacePath of workspacePaths) {
    for (const provider of allProviders) {
      const source = await provider.skills.getProjectSkillTarget(workspacePath);
      if (!source) {
        continue;
      }

      supportedProviders.add(provider.id);
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
  }

  const unsupported = allProviders
    .map((provider) => provider.id)
    .filter((providerId) => !supportedProviders.has(providerId));

  return { targets: [...byRootDir.values()], unsupported };
};

/**
 * Reads the canonical copy of a managed skill back into an installable entry:
 * the SKILL.md markdown plus every supporting file (base64-encoded so binary
 * assets survive re-installation). Used when re-scoping re-materializes the
 * skill into a different set of agent folders.
 */
const readCanonicalSkillEntry = async (
  managedRoot: string,
  directoryName: string,
): Promise<ProviderSkillCreateEntry> => {
  const skillDirectoryPath = path.join(managedRoot, directoryName);
  const content = (await readFile(path.join(skillDirectoryPath, 'SKILL.md'), 'utf8')).trim();

  const files: NonNullable<ProviderSkillCreateEntry['files']> = [];
  const walk = async (currentDir: string): Promise<void> => {
    const dirents = await readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!dirent.isFile() || dirent.name === 'SKILL.md') {
        continue;
      }
      const relativePath = path.relative(skillDirectoryPath, absolutePath).split(path.sep).join('/');
      const fileContent = await readFile(absolutePath);
      files.push({ relativePath, content: fileContent.toString('base64'), encoding: 'base64' });
    }
  };
  await walk(skillDirectoryPath);

  return { content, directoryName, ...(files.length > 0 ? { files } : {}) };
};

const readManifest = async (): Promise<Manifest> => {
  const raw = await readJsonConfig(getManifestPath());
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
      scope: entry.scope === 'projects' ? 'projects' : 'all',
      projects: Array.isArray(entry.projects)
        ? entry.projects.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }

  return { skills: normalized };
};

const writeManifest = async (manifest: Manifest): Promise<void> => {
  await writeJsonConfig(getManifestPath(), { skills: manifest.skills });
};

const directoryExists = async (directoryPath: string): Promise<boolean> => {
  try {
    const stats = await stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const getMemoryTemplatePath = (): string =>
  path.join(getManagedRoot(), MEMORY_SKILL_DIRECTORY_NAME, 'SKILL.md');

/**
 * Seeds the editable memory skill template into the canonical store on first
 * use. The template is listed in the Global Skills tab but never fanned out.
 */
const ensureMemoryTemplate = async (): Promise<void> => {
  const templatePath = getMemoryTemplatePath();
  try {
    await stat(templatePath);
    return;
  } catch {
    // Missing — seed below.
  }

  await mkdir(path.dirname(templatePath), { recursive: true });
  await writeFile(templatePath, MEMORY_SKILL_TEMPLATE, 'utf8');
};

const validateSkillContent = (directoryName: string, content: string): string => {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (!trimmed) {
    throw new AppError('Skill content must not be empty.', {
      code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
      statusCode: 400,
    });
  }

  // Throws a 400 AppError when the front matter does not carry a valid name.
  readProviderSkillMarkdownDefinitionFromContent(trimmed, directoryName);
  return trimmed;
};

/**
 * Overwrites only SKILL.md inside each given root directory, leaving supporting
 * files (scripts, references) untouched. Used for in-place content edits.
 */
const overwriteSkillMarkdown = async (rootDir: string, directoryName: string, content: string): Promise<void> => {
  const skillDirectoryPath = path.join(rootDir, directoryName);
  if (!isPathInsideRoot(rootDir, skillDirectoryPath) || path.resolve(skillDirectoryPath) === path.resolve(rootDir)) {
    throw new AppError('Skill directory must stay inside the managed skill root.', {
      code: 'GLOBAL_SKILL_DIRECTORY_INVALID',
      statusCode: 400,
    });
  }

  await writeFile(path.join(skillDirectoryPath, 'SKILL.md'), `${content}\n`, 'utf8');
};

export const globalSkillsService = {
  /**
   * Lists managed global skills, the managed memory template first.
   */
  async listGlobalSkills(): Promise<GlobalSkill[]> {
    await ensureMemoryTemplate();

    const managedRoot = getManagedRoot();
    const manifest = await readManifest();
    const { unsupported } = await resolveTargets();

    const skillFiles = await findProviderSkillMarkdownFiles(managedRoot, { recursive: false });
    const skills: GlobalSkill[] = [];

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
          unsupported,
          scope: manifestEntry?.scope ?? 'all',
          projects: manifestEntry?.projects ?? [],
          ...(directoryName === MEMORY_SKILL_DIRECTORY_NAME ? { kind: 'memory-template' as const } : {}),
        });
      } catch {
        // A malformed managed skill should not hide the rest of the list.
      }
    }

    return skills.sort((left, right) => {
      if (left.kind === 'memory-template') {
        return -1;
      }
      if (right.kind === 'memory-template') {
        return 1;
      }
      return left.directoryName.localeCompare(right.directoryName);
    });
  },

  /**
   * Installs one or more global skills and fans them out according to `scope`.
   * `all` writes to every agent's user-scope skill directory (every project);
   * `projects` writes only to the given workspaces' project-scope skill
   * directories. A target agent folder is skipped when a non-managed skill of
   * the same name already exists there.
   */
  async addGlobalSkills(input: GlobalSkillCreateInput): Promise<GlobalSkill[]> {
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new AppError('At least one skill entry is required.', {
        code: 'GLOBAL_SKILLS_REQUIRED',
        statusCode: 400,
      });
    }

    const scope: GlobalSkillScope = input.scope === 'projects' ? 'projects' : 'all';
    const projects = scope === 'projects'
      ? [...new Set(
          (input.projects ?? [])
            .map((workspacePath) => (typeof workspacePath === 'string' ? workspacePath.trim() : ''))
            .filter((workspacePath) => workspacePath.length > 0)
            .map((workspacePath) => path.resolve(workspacePath)),
        )]
      : [];
    if (scope === 'projects' && projects.length === 0) {
      throw new AppError('Select at least one project for a project-scoped skill.', {
        code: 'GLOBAL_SKILL_PROJECTS_REQUIRED',
        statusCode: 400,
      });
    }

    const managedRoot = getManagedRoot();
    const resolved = scope === 'projects'
      ? await resolveProjectTargets(projects)
      : await resolveTargets();
    // Optional explicit provider filter — empty array means catalog-only (no fan-out).
    const providerFilter = Array.isArray(input.providers)
      ? new Set(input.providers)
      : null;
    const targets = providerFilter
      ? resolved.targets
          .map((target) => ({
            ...target,
            providers: target.providers.filter((p) => providerFilter.has(p)),
          }))
          .filter((target) => target.providers.length > 0)
      : resolved.targets;
    const unsupported = providerFilter
      ? [
          ...resolved.unsupported,
          ...providerRegistry.listProviders()
            .map((p) => p.id)
            .filter((id) => !providerFilter.has(id) && !resolved.unsupported.includes(id)),
        ]
      : resolved.unsupported;
    const manifest = await readManifest();

    // Validate every entry against the canonical root before touching disk so a
    // bad entry cannot leave the store half-written.
    const canonicalSeen = new Set<string>();
    const canonicalInstalls = input.entries.map((entry, index) =>
      prepareSkillInstall(managedRoot, entry, index, canonicalSeen));

    const results: GlobalSkill[] = [];

    for (const [index, canonicalInstall] of canonicalInstalls.entries()) {
      const entry = input.entries[index];
      const { directoryName } = canonicalInstall;

      if (directoryName === MEMORY_SKILL_DIRECTORY_NAME) {
        throw new AppError(
          'The memory skill template is managed. Edit it from the Global Skills tab instead of installing it directly.',
          { code: 'GLOBAL_SKILL_MANAGED', statusCode: 400 },
        );
      }

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
        scope,
        projects,
      };

      results.push({
        name: canonicalInstall.definition.name,
        description: canonicalInstall.definition.description,
        directoryName,
        sourcePath: canonicalInstall.skillPath,
        providers: [...new Set(coveredProviders)],
        conflicts: [...new Set(conflictProviders)],
        unsupported,
        scope,
        projects,
      });
    }

    await writeManifest(manifest);
    return results;
  },

  /**
   * Removes a global skill from the canonical folder and every agent folder it
   * was written to. The managed memory template cannot be removed.
   */
  async removeGlobalSkill(
    input: GlobalSkillRemoveInput,
  ): Promise<{ removed: boolean; directoryName: string; providers: LLMProvider[] }> {
    const directoryName = requireManagedDirectoryName(input.directoryName);
    const managedRoot = getManagedRoot();
    const manifest = await readManifest();
    const manifestEntry = manifest.skills[directoryName];

    // Fall back to the currently resolved agent folders when the manifest has no
    // record, so a skill written before the manifest existed can still be torn
    // down. Only directories that resolve inside a known target root are removed.
    const targetRootDirs = manifestEntry?.targets?.length
      ? manifestEntry.targets
      : (await resolveTargets()).targets.map((target) => path.resolve(target.rootDir));

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
        code: 'GLOBAL_SKILL_DIRECTORY_INVALID',
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
      await writeManifest(manifest);
    }

    return { removed, directoryName, providers };
  },

  /**
   * Re-scopes a global skill. `all` fans the canonical copy out to every
   * agent's user-scope skill folder; `projects` installs it only into the
   * given workspaces' project-scope skill folders. Copies in folders that fall
   * out of scope are removed; folders that already hold a non-managed skill of
   * the same name are reported as conflicts and left untouched. The managed
   * memory template cannot be re-scoped.
   */
  async setGlobalSkillScope(
    input: GlobalSkillScopeUpdateInput,
  ): Promise<Pick<GlobalSkill, 'directoryName' | 'scope' | 'projects' | 'providers' | 'conflicts' | 'unsupported'>> {
    const directoryName = requireManagedDirectoryName(input.directoryName);
    const scope: GlobalSkillScope = input.scope === 'projects' ? 'projects' : 'all';

    const managedRoot = getManagedRoot();
    const canonicalSkillPath = path.join(managedRoot, directoryName, 'SKILL.md');
    try {
      await stat(canonicalSkillPath);
    } catch {
      throw new AppError(`Global skill "${directoryName}" was not found.`, {
        code: 'GLOBAL_SKILL_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projects = scope === 'projects'
      ? [...new Set(
          (input.projects ?? [])
            .map((workspacePath) => (typeof workspacePath === 'string' ? workspacePath.trim() : ''))
            .filter((workspacePath) => workspacePath.length > 0)
            .map((workspacePath) => path.resolve(workspacePath)),
        )]
      : [];
    if (scope === 'projects' && projects.length === 0) {
      throw new AppError('Select at least one project for a project-scoped skill.', {
        code: 'GLOBAL_SKILL_PROJECTS_REQUIRED',
        statusCode: 400,
      });
    }

    const resolved = scope === 'projects'
      ? await resolveProjectTargets(projects)
      : await resolveTargets();
    const providerFilter = Array.isArray(input.providers)
      ? new Set(input.providers)
      : null;
    const targets = providerFilter
      ? resolved.targets
          .map((target) => ({
            ...target,
            providers: target.providers.filter((p) => providerFilter.has(p)),
          }))
          .filter((target) => target.providers.length > 0)
      : resolved.targets;
    const unsupported = providerFilter
      ? [
          ...resolved.unsupported,
          ...providerRegistry.listProviders()
            .map((p) => p.id)
            .filter((id) => !providerFilter.has(id) && !resolved.unsupported.includes(id)),
        ]
      : resolved.unsupported;

    const manifest = await readManifest();
    const previousTargets = new Set(manifest.skills[directoryName]?.targets ?? []);
    const nextTargetRoots = new Set(targets.map((target) => path.resolve(target.rootDir)));

    // Tear down copies in folders that fall out of scope (or left the provider filter).
    for (const previousRoot of previousTargets) {
      if (nextTargetRoots.has(previousRoot)) {
        continue;
      }

      const targetSkillDir = path.join(previousRoot, directoryName);
      if (!isPathInsideRoot(previousRoot, targetSkillDir) || path.resolve(targetSkillDir) === path.resolve(previousRoot)) {
        continue;
      }

      await rm(targetSkillDir, { recursive: true, force: true });
    }

    const entry = await readCanonicalSkillEntry(managedRoot, directoryName);
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
      const targetInstall = prepareSkillInstall(target.rootDir, entry, 0, targetSeen);
      await writeSkillInstall(targetInstall);
      writtenTargets.push(resolvedRootDir);
      coveredProviders.push(...target.providers);
    }

    // One provider can cover several target roots (one per scoped workspace) —
    // report each agent once.
    const uniqueProviders = [...new Set(coveredProviders)];
    const uniqueConflicts = [...new Set(conflictProviders)];

    manifest.skills[directoryName] = {
      targets: writtenTargets,
      providers: uniqueProviders,
      updatedAt: new Date().toISOString(),
      scope,
      projects,
    };
    await writeManifest(manifest);

    return { directoryName, scope, projects, providers: uniqueProviders, conflicts: uniqueConflicts, unsupported };
  },

  /**
   * Returns the raw markdown of one managed global skill (or the memory
   * template) from the canonical store.
   */
  async getGlobalSkillContent(input: GlobalSkillContentInput): Promise<SkillContentResult> {
    const directoryName = requireDirectoryName(input.directoryName);
    if (directoryName === MEMORY_SKILL_DIRECTORY_NAME) {
      await ensureMemoryTemplate();
    }

    const skillPath = path.join(getManagedRoot(), directoryName, 'SKILL.md');
    let content: string;
    try {
      content = await readFile(skillPath, 'utf8');
    } catch {
      throw new AppError(`Global skill "${directoryName}" was not found.`, {
        code: 'GLOBAL_SKILL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return { directoryName, content };
  },

  /**
   * Rewrites one managed global skill's markdown in place: the canonical copy
   * and every manifest-recorded agent copy. Supporting files are preserved. The
   * folder is the skill's identity — changing the front matter `name` does not
   * move it. The memory template is written to the canonical store only; the
   * route layer re-renders memory-enabled projects afterwards.
   */
  async updateGlobalSkillContent(input: GlobalSkillContentUpdateInput): Promise<SkillContentResult> {
    const directoryName = requireDirectoryName(input.directoryName);
    const content = validateSkillContent(directoryName, input.content);

    if (directoryName === MEMORY_SKILL_DIRECTORY_NAME) {
      await ensureMemoryTemplate();
      await writeFile(getMemoryTemplatePath(), `${content}\n`, 'utf8');
      return { directoryName, content };
    }

    const managedRoot = getManagedRoot();
    const skillPath = path.join(managedRoot, directoryName, 'SKILL.md');
    try {
      await stat(skillPath);
    } catch {
      throw new AppError(`Global skill "${directoryName}" was not found.`, {
        code: 'GLOBAL_SKILL_NOT_FOUND',
        statusCode: 404,
      });
    }

    const manifest = await readManifest();
    const targetRootDirs = manifest.skills[directoryName]?.targets ?? [];

    await overwriteSkillMarkdown(managedRoot, directoryName, content);
    for (const rootDir of targetRootDirs) {
      // A scoped target (for example a deleted project's skill folder) may have
      // vanished from disk — skip it instead of failing the whole edit.
      if (!(await directoryExists(path.join(rootDir, directoryName)))) {
        continue;
      }
      await overwriteSkillMarkdown(rootDir, directoryName, content);
    }

    return { directoryName, content };
  },

  /**
   * Returns the active memory skill template markdown: the user-edited copy in
   * the canonical store when present, otherwise the built-in default.
   */
  async getMemorySkillTemplate(): Promise<string> {
    await ensureMemoryTemplate();
    try {
      return await readFile(getMemoryTemplatePath(), 'utf8');
    } catch {
      return MEMORY_SKILL_TEMPLATE;
    }
  },
};
