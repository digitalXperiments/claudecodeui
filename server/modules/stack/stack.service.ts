import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { projectsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { checkAuthHealth } from '@/modules/auth-health/index.js';
import { projectSkillsService } from '@/modules/providers/index.js';
import { globalSkillsService } from '@/modules/providers/index.js';
import { mcpCatalogService } from '@/modules/providers/index.js';
import { probeMcpServerHealth, resolveExecutableOnPath } from '@/modules/auth-health/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { AppError } from '@/shared/utils.js';
import type {
  StackApplyResult,
  StackConfig,
  StackDoctorCheck,
  StackDoctorReport,
  StackDocument,
  StackExportResult,
  StackMcpBinding,
} from '@/modules/stack/stack.types.js';
import type { LLMProvider, ProviderMcpServer } from '@/shared/types.js';

const STACK_DIRECTORY = '.cloudcli';
const STACK_FILE_NAME = 'stack.yaml';
const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  kilo: 'kilo',
  cline: 'cline',
  grok: 'grok',
  kimi: 'kimi',
  qwencode: 'qwen',
  pi: 'pi',
};

function projectPathForId(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) throw new AppError(`Project not found: ${projectId}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  return path.resolve(projectPath);
}

function stackPathForProject(projectPath: string): string {
  return path.join(projectPath, STACK_DIRECTORY, STACK_FILE_NAME);
}

function defaultConfig(projectPath: string): StackConfig {
  return {
    version: 1,
    project: path.basename(projectPath),
    providers: { required: [], optional: [] },
    mcp: [],
    skills: { global: [], project: [] },
    health: { auth: [], mcp: [] },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function normalizeConfig(value: unknown, projectPath: string): StackConfig {
  const raw = objectValue(value);
  const providers = objectValue(raw.providers);
  const skills = objectValue(raw.skills);
  const health = objectValue(raw.health);
  const mcp = Array.isArray(raw.mcp)
    ? raw.mcp
        .map((item) => typeof item === 'string' ? { name: item } : objectValue(item))
        .filter((item): item is StackMcpBinding => typeof item.name === 'string' && item.name.trim().length > 0)
        .map((item) => ({ ...item, name: item.name.trim(), enabledFor: stringList(item.enabledFor) }))
    : [];
  return {
    ...raw,
    version: typeof raw.version === 'number' ? raw.version : 1,
    project: typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim() : path.basename(projectPath),
    providers: {
      ...providers,
      required: stringList(providers.required),
      optional: stringList(providers.optional),
    },
    mcp,
    skills: { ...skills, global: stringList(skills.global), project: stringList(skills.project) },
    health: { ...health, auth: stringList(health.auth), mcp: stringList(health.mcp) },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDocument(projectId: string): Promise<StackDocument> {
  const projectPath = projectPathForId(projectId);
  const stackPath = stackPathForProject(projectPath);
  if (!(await fileExists(stackPath))) {
    return { projectId, projectPath, path: stackPath, exists: false, config: defaultConfig(projectPath) };
  }
  try {
    const parsed = parseYaml(await readFile(stackPath, 'utf8'));
    return { projectId, projectPath, path: stackPath, exists: true, config: normalizeConfig(parsed, projectPath) };
  } catch (error) {
    throw new AppError(`Could not parse ${stackPath}: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'STACK_DOCTOR_FAILED',
      statusCode: 400,
    });
  }
}

async function writeDocument(projectId: string, config: StackConfig): Promise<StackDocument> {
  const projectPath = projectPathForId(projectId);
  const normalized = normalizeConfig(config, projectPath);
  const stackPath = stackPathForProject(projectPath);
  await mkdir(path.dirname(stackPath), { recursive: true });
  await writeFile(stackPath, stringifyYaml(normalized), 'utf8');
  return { projectId, projectPath, path: stackPath, exists: true, config: normalized };
}

async function ensureGitignore(projectPath: string): Promise<boolean> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  let existing = '';
  try { existing = await readFile(gitignorePath, 'utf8'); } catch { /* create below */ }
  const covered = existing.split(/\r?\n/).some((line) => ['.cloudcli/worktrees', '.cloudcli/worktrees/', '.cloudcli/'].includes(line.trim()));
  if (covered) return true;
  const block = '# CloudCLI agent workspaces\n.cloudcli/worktrees/\n';
  await writeFile(gitignorePath, existing.trimEnd() ? `${existing.trimEnd()}\n${block}` : block, 'utf8');
  return true;
}

function collectSecretRefs(value: unknown, prefix = '$'): Array<{ ref: string; path: string }> {
  const refs: Array<{ ref: string; path: string }> = [];
  const walk = (current: unknown, currentPath: string): void => {
    if (typeof current === 'string') {
      for (const match of current.matchAll(/\$\{secret:([^}]+)\}/g)) {
        refs.push({ ref: `\${secret:${match[1]}}`, path: currentPath });
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (current && typeof current === 'object') {
      Object.entries(current as Record<string, unknown>).forEach(([key, item]) => walk(item, `${currentPath}.${key}`));
    }
  };
  walk(value, prefix);
  return refs;
}

function redactExport(value: unknown, key = '', sensitiveContainer = false): unknown {
  if (typeof value === 'string') {
    return value.includes('${secret:') ? value : sensitiveContainer || /authorization|secret|token|password|api[-_]?key|private[-_]?key/i.test(key) ? '${secret:REDACTED}' : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactExport(item, key, sensitiveContainer));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, redactExport(entry, entryKey, sensitiveContainer || entryKey === 'env' || entryKey === 'headers')]));
  }
  return value;
}

function check(id: string, label: string, ok: boolean, message: string, fix?: string, details?: unknown): StackDoctorCheck {
  return { id, label, ok, status: ok ? 'pass' : 'fail', message, ...(fix ? { fix } : {}), ...(details === undefined ? {} : { details }) };
}

function skipped(id: string, label: string, message: string): StackDoctorCheck {
  return { id, label, ok: true, status: 'skipped', message };
}

async function doctorProviders(config: StackConfig, checks: StackDoctorCheck[]): Promise<void> {
  const required = stringList(config.providers?.required);
  if (required.length === 0) {
    checks.push(skipped('provider-binary', 'Provider binaries', 'No required providers are declared.'));
    checks.push(skipped('auth', 'Provider auth', 'No required providers are declared.'));
    return;
  }

  const binaries = await Promise.all(required.map(async (provider) => ({
    provider,
    binary: PROVIDER_BINARIES[provider] ?? provider,
    found: await resolveExecutableOnPath(PROVIDER_BINARIES[provider] ?? provider),
  })));
  const missing = binaries.filter((entry) => !entry.found);
  checks.push(check(
    'provider-binary',
    'Provider binaries',
    missing.length === 0,
    missing.length === 0 ? `Found ${required.length} required provider binary(ies).` : `Missing provider binary(ies): ${missing.map((entry) => entry.provider).join(', ')}.`,
    missing.length === 0 ? undefined : 'Install the provider CLI or update the provider command in your environment.',
    binaries,
  ));

  try {
    const report = await checkAuthHealth();
    const expected = stringList(config.health?.auth).length ? stringList(config.health?.auth) : required;
    const states = expected.map((provider) => report.providers.find((entry) => entry.provider === provider) ?? { provider, installed: false, authenticated: false, error: 'Provider was not returned by auth-health.' });
    const unhealthy = states.filter((entry) => !entry.installed || !entry.authenticated);
    checks.push(check(
      'auth',
      'Provider auth',
      unhealthy.length === 0,
      unhealthy.length === 0 ? `Auth health is green for ${expected.join(', ')}.` : `Auth needs attention for: ${unhealthy.map((entry) => entry.provider).join(', ')}.`,
      unhealthy.length === 0 ? undefined : 'Sign in to the listed provider(s), then run doctor again.',
      states,
    ));
  } catch (error) {
    checks.push(check('auth', 'Provider auth', false, `Auth-health probe failed: ${error instanceof Error ? error.message : String(error)}`, 'Run POST /api/auth-health/check and inspect the provider logs.'));
  }
}

async function doctorMcp(config: StackConfig, checks: StackDoctorCheck[]): Promise<void> {
  const bindings = Array.isArray(config.mcp) ? config.mcp : [];
  const expectedNames = stringList(config.health?.mcp);
  if (bindings.length === 0 && expectedNames.length === 0) {
    checks.push(skipped('mcp', 'MCP bindings', 'No MCP expectations are declared.'));
    return;
  }
  const catalog = await mcpCatalogService.listCatalog();
  const names = [...new Set([...bindings.map((binding) => binding.name), ...expectedNames])];
  const providers = stringList(config.providers?.required);
  const results: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const binding = bindings.find((entry) => entry.name === name);
    const entry = catalog.find((candidate) => candidate.name === name);
    if (!entry) {
      results.push({ name, ok: false, error: 'Not present in the CloudCLI MCP catalog.' });
      continue;
    }
    const enabledFor = stringList(binding?.enabledFor).length ? stringList(binding?.enabledFor) : providers;
    const probeProviders = enabledFor.length ? enabledFor : Object.entries(entry.bindings).filter(([, value]) => value?.enabled).map(([provider]) => provider);
    if (enabledFor.some((provider) => !entry.bindings[provider as LLMProvider]?.enabled)) {
      results.push({ name, ok: false, error: `Catalog binding is disabled for ${enabledFor.filter((provider) => !entry.bindings[provider as LLMProvider]?.enabled).join(', ')}.` });
      continue;
    }
    const probes = await Promise.all(probeProviders.map(async (provider) => {
      const probe = await probeMcpServerHealth({
        provider: provider as LLMProvider,
        name,
        scope: entry.scope,
        transport: entry.transport,
        command: entry.command,
        url: entry.url,
      } satisfies ProviderMcpServer);
      return { provider, ...probe };
    }));
    results.push({ name, ok: probes.every((probe) => probe.healthy), probes });
  }
  const failed = results.filter((result) => result.ok !== true);
  checks.push(check('mcp', 'MCP bindings', failed.length === 0, failed.length === 0 ? `MCP is healthy for ${names.join(', ')}.` : `MCP needs attention for: ${failed.map((result) => String(result.name)).join(', ')}.`, failed.length === 0 ? undefined : 'Create/fix the catalog binding and its provider projections, then run doctor again.', results));
}

async function doctorSecrets(projectId: string, config: StackConfig, checks: StackDoctorCheck[]): Promise<void> {
  const refs = collectSecretRefs(config);
  if (refs.length === 0) {
    checks.push(skipped('secrets', 'Secret references', 'No secret references are declared.'));
    return;
  }
  const resolved: Array<Record<string, unknown>> = [];
  for (const entry of refs) {
    try {
      secretsService.resolve(entry.ref, { projectId });
      resolved.push({ path: entry.path, ref: entry.ref, ok: true });
    } catch (error) {
      resolved.push({ path: entry.path, ref: entry.ref, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const missing = resolved.filter((entry) => entry.ok !== true);
  checks.push(check('secrets', 'Secret references', missing.length === 0, missing.length === 0 ? `Resolved ${refs.length} secret reference(s).` : `Could not resolve ${missing.length} secret reference(s).`, missing.length === 0 ? undefined : 'Store the missing secret(s) in the CloudCLI vault, then run doctor again.', resolved));
}

export const stackService = {
  async get(projectId: string): Promise<StackDocument> {
    return readDocument(projectId);
  },

  async put(projectId: string, config: StackConfig): Promise<StackDocument> {
    return writeDocument(projectId, config);
  },

  async apply(projectId: string, config?: StackConfig): Promise<StackApplyResult> {
    const existing = await readDocument(projectId);
    const document = await writeDocument(projectId, config ?? existing.config);
    const warnings: string[] = [];
    const refs = collectSecretRefs(document.config);
    for (const entry of refs) {
      try { secretsService.resolve(entry.ref, { projectId }); } catch { warnings.push(`Unresolved secret reference at ${entry.path}: ${entry.ref}`); }
    }
    if (Array.isArray(document.config.mcp) && document.config.mcp.length > 0) {
      const catalog = await mcpCatalogService.listCatalog();
      for (const binding of document.config.mcp) {
        if (!catalog.some((entry) => entry.name === binding.name)) warnings.push(`MCP catalog entry is missing: ${binding.name}`);
      }
    }
    await ensureGitignore(document.projectPath);
    return { applied: true, document, warnings };
  },

  async export(projectId: string): Promise<StackExportResult> {
    const document = await readDocument(projectId);
    const config = redactExport(document.config) as StackConfig;
    return { path: document.path, format: 'yaml', yaml: stringifyYaml(config), config };
  },

  async doctor(projectId: string, options: { createInterrupts?: boolean } = {}): Promise<StackDoctorReport> {
    const document = await readDocument(projectId);
    const checks: StackDoctorCheck[] = [];
    checks.push(document.exists
      ? check('stack-file', 'Stack capsule', true, `Loaded ${document.path}.`)
      : check('stack-file', 'Stack capsule', false, `${document.path} does not exist.`, 'Run POST /api/projects/:id/stack/apply or PUT the stack configuration.'));

    await doctorProviders(document.config, checks);
    await doctorMcp(document.config, checks);
    await doctorSecrets(projectId, document.config, checks);

    const orphaned = await workspaceService.reconcileOrphanedWorkspaces(projectId);
    const knownOrphans = workspaceService.list(projectId, { status: ['orphan'] });
    checks.push(check('worktrees', 'Workspace worktrees', knownOrphans.length === 0, knownOrphans.length === 0 ? 'No orphaned workspaces found.' : `${knownOrphans.length} orphaned workspace(s) need cleanup.`, knownOrphans.length === 0 ? undefined : 'Inspect or clean the orphaned workspaces before applying new work.', { reconciled: orphaned.length, orphans: knownOrphans.map((workspace) => workspace.workspace_id) }));

    const gitignore = await readFile(path.join(document.projectPath, '.gitignore'), 'utf8').catch(() => '');
    const hasGitignore = gitignore.split(/\r?\n/).some((line) => ['.cloudcli/worktrees', '.cloudcli/worktrees/', '.cloudcli/'].includes(line.trim()));
    checks.push(check('gitignore', 'Workspace gitignore', hasGitignore, hasGitignore ? '.cloudcli/worktrees is ignored.' : '.cloudcli/worktrees is missing from .gitignore.', 'Run stack apply to add the managed worktree ignore entry.'));

    const projectSkillNames = stringList(document.config.skills?.project);
    const globalSkillNames = stringList(document.config.skills?.global);
    if (projectSkillNames.length === 0 && globalSkillNames.length === 0) {
      checks.push(skipped('skills', 'Skill fan-out', 'No required skills are declared.'));
    } else {
      const [projectSkills, globalSkills] = await Promise.all([
        projectSkillsService.listProjectSkills({ workspacePath: document.projectPath }),
        globalSkillsService.listGlobalSkills(),
      ]);
      const availableProject = new Set(projectSkills.flatMap((skill) => [skill.directoryName, skill.name]));
      const availableGlobal = new Set(globalSkills.flatMap((skill) => [skill.directoryName, skill.name]));
      const missingProject = projectSkillNames.filter((name) => !availableProject.has(name));
      const missingGlobal = globalSkillNames.filter((name) => !availableGlobal.has(name));
      checks.push(check('skills', 'Skill fan-out', missingProject.length === 0 && missingGlobal.length === 0, missingProject.length || missingGlobal.length ? `Missing skills: ${[...missingProject, ...missingGlobal].join(', ')}.` : 'Declared skills are present.', 'Install or re-scope the missing skills, then run doctor again.', { missingProject, missingGlobal }));
    }

    const failed = checks.filter((entry) => entry.status === 'fail');
    const interruptIds: string[] = [];
    if (options.createInterrupts !== false) {
      for (const failure of failed) {
        const interrupt = interruptsService.create({
          projectId,
          kind: 'stack_doctor_failed',
          severity: 'error',
          title: `Workspace doctor: ${failure.label}`,
          body: failure.message,
          href: `/projects/${projectId}/stack`,
          actions: [{ id: 'open_href', label: 'Open stack', style: 'primary' }, { id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
          meta: { checkId: failure.id, fix: failure.fix ?? null },
          dedupeKey: `stack-doctor:${projectId}:${failure.id}`,
        });
        interruptIds.push(interrupt.interrupt_id);
      }
    }
    return { projectId, projectPath: document.projectPath, stackPath: document.path, ok: failed.length === 0, checks, generatedAt: new Date().toISOString(), interruptIds };
  },
};

export { normalizeConfig };
