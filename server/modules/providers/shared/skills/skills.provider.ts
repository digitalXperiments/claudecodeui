import path from 'node:path';
import { rm, stat } from 'node:fs/promises';

import type { IProviderSkills } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  findProviderSkillMarkdownFiles,
  readProviderSkillMarkdownDefinition,
  AppError,
} from '@/shared/utils.js';
import {
  normalizeSkillDirectoryName,
  prepareSkillInstall,
  writeSkillInstall,
} from '@/modules/providers/shared/skills/skills.materialize.js';

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

/**
 * Shared skills provider for provider-specific skill source discovery.
 */
export abstract class SkillsProvider implements IProviderSkills {
  protected readonly provider: LLMProvider;

  protected constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const workspacePath = resolveWorkspacePath(options?.workspacePath);
    const sources = await this.getSkillSources(workspacePath);
    const skills: ProviderSkill[] = [];

    for (const source of sources) {
      const skillFiles = await findProviderSkillMarkdownFiles(source.rootDir, {
        recursive: source.recursive,
      });
      for (const skillPath of skillFiles) {
        try {
          const definition = await readProviderSkillMarkdownDefinition(skillPath);
          const command = source.commandForSkill
            ? source.commandForSkill(definition.name)
            : `${source.commandPrefix ?? '/'}${definition.name}`;

          skills.push({
            provider: this.provider,
            name: definition.name,
            description: definition.description,
            command,
            scope: source.scope,
            sourcePath: skillPath,
            pluginName: source.pluginName,
            pluginId: source.pluginId,
          });
        } catch {
          // A malformed or unreadable skill markdown file should not hide other valid skills.
        }
      }
    }

    return skills;
  }

  async addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]> {
    const globalSkillSource = await this.getGlobalSkillSource();
    if (!globalSkillSource) {
      throw new AppError(`${this.provider} does not support managed global skills.`, {
        code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new AppError('At least one skill entry is required.', {
        code: 'PROVIDER_SKILLS_REQUIRED',
        statusCode: 400,
      });
    }

    const seenSkillPaths = new Set<string>();
    const pendingInstalls = input.entries.map((entry, index) =>
      prepareSkillInstall(globalSkillSource.rootDir, entry, index, seenSkillPaths));

    const skills: ProviderSkill[] = pendingInstalls.map((install) => {
      const command = globalSkillSource.commandForSkill
        ? globalSkillSource.commandForSkill(install.definition.name)
        : `${globalSkillSource.commandPrefix ?? '/'}${install.definition.name}`;

      return {
        provider: this.provider,
        name: install.definition.name,
        description: install.definition.description,
        command,
        scope: globalSkillSource.scope,
        sourcePath: install.skillPath,
        pluginName: globalSkillSource.pluginName,
        pluginId: globalSkillSource.pluginId,
      };
    });

    for (const install of pendingInstalls) {
      await writeSkillInstall(install);
    }

    return skills;
  }

  async removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }> {
    const globalSkillSource = await this.getGlobalSkillSource();
    if (!globalSkillSource) {
      throw new AppError(`${this.provider} does not support managed global skills.`, {
        code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    const directoryName = normalizeSkillDirectoryName(input.directoryName);
    if (!directoryName) {
      throw new AppError('Skill directoryName is required.', {
        code: 'PROVIDER_SKILL_DIRECTORY_REQUIRED',
        statusCode: 400,
      });
    }

    const skillDirectoryPath = path.join(globalSkillSource.rootDir, directoryName);
    const resolvedRoot = path.resolve(globalSkillSource.rootDir);
    const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
    if (
      resolvedSkillDirectoryPath !== resolvedRoot
      && !resolvedSkillDirectoryPath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new AppError('Skill directory must stay inside the managed skill root.', {
        code: 'PROVIDER_SKILL_DIRECTORY_INVALID',
        statusCode: 400,
      });
    }

    const removed = await stat(resolvedSkillDirectoryPath)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (removed) {
      await rm(resolvedSkillDirectoryPath, { recursive: true, force: true });
    }

    return { removed, provider: this.provider, directoryName };
  }

  async getProjectSkillTarget(_workspacePath: string): Promise<ProviderSkillSource | null> {
    return null;
  }

  /**
   * Public accessor for the provider's writable user-scope skill directory, used
   * by the cross-agent global skills fan-out. Returns null for providers that do
   * not support managed global skills.
   */
  async getGlobalSkillTarget(): Promise<ProviderSkillSource | null> {
    return this.getGlobalSkillSource();
  }

  protected abstract getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]>;

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return null;
  }
}
