import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { contextPacksDb } from '@/modules/context-packs/context-packs.repository.js';
import type { ContextPack, ContextPackAttachment, ContextPackItem } from '@/modules/context-packs/context-packs.types.js';
import { kanbanDb } from '@/modules/kanban/index.js';
import { projectsDb, projectMemoryDb, sessionsDb } from '@/modules/database/index.js';
import { runGit } from '@/modules/workspaces/index.js';
import { runService } from '@/modules/runs/index.js';
import { obsidianSettingsService } from '@/modules/providers/index.js';
import { CloudError } from '@/shared/run-events.js';
import { AppError } from '@/shared/utils.js';

const DEFAULT_BUDGET = 6000;
const MAX_BUDGET = 50_000;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 500_000;
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mdx',
  '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml',
]);
const STOP_WORDS = new Set('a an and are as at be by for from in into is it of on or that the this to with you'.split(' '));

function projectPathForId(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) throw new AppError(`Project not found: ${projectId}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  return path.resolve(projectPath);
}

function tokenize(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((word) => !STOP_WORDS.has(word)))];
}

function scoreText(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function excerptAtRelevantLine(content: string, terms: string[], maxChars = 2200): string {
  if (content.length <= maxChars) return content.trim();
  const lines = content.split(/\r?\n/);
  const relevant = lines.findIndex((line) => scoreText(line, terms) > 0);
  const startLine = Math.max(0, (relevant < 0 ? 0 : relevant) - 5);
  const excerpt = lines.slice(startLine, startLine + 40).join('\n');
  return excerpt.length <= maxChars ? excerpt : `${excerpt.slice(0, maxChars)}\n…`;
}

function safeFilePath(projectPath: string, candidate: string): string | null {
  const resolved = path.resolve(projectPath, candidate);
  const relative = path.relative(projectPath, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

async function collectTextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const ignored = new Set(['.git', '.taskmaster', '.cloudcli', 'node_modules', 'dist', 'dist-server', 'build', 'coverage', 'tmp']);
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory() && !ignored.has(entry.name)) {
        await walk(path.join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(directory, entry.name));
      }
    }
  };
  await walk(root, 0);
  return files;
}

async function readTextFile(filePath: string): Promise<{ text: string; mtime: string } | null> {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size > MAX_FILE_BYTES) return null;
    return { text: await readFile(filePath, 'utf8'), mtime: fileStats.mtime.toISOString() };
  } catch {
    return null;
  }
}

function itemText(item: ContextPackItem): string {
  return `### ${item.title}\nSource: ${item.uri}\nScore: ${item.score.toFixed(2)}\n\n${item.excerpt}`;
}

function buildMarkdown(goal: string, items: ContextPackItem[], warnings: string[]): string {
  const lines = ['# CloudCLI Context Pack', '', `Goal: ${goal}`, ''];
  for (const item of items) lines.push(`## ${item.kind}`, '', itemText(item), '');
  if (warnings.length) lines.push('## Warnings', '', ...warnings.map((warning) => `- ${warning}`), '');
  return lines.join('\n').trim();
}

async function collectMemoryItems(projectPath: string, terms: string[], warnings: string[]): Promise<ContextPackItem[]> {
  const mapping = projectMemoryDb.get(projectPath);
  if (!mapping?.enabled) return [];
  const settings = obsidianSettingsService.getSettings();
  if (!settings.vaultPath.trim()) {
    warnings.push('Project memory is enabled but the Obsidian vault path is not configured.');
    return [];
  }
  const vaultRoot = path.resolve(settings.vaultPath);
  const memoryRoot = path.resolve(vaultRoot, mapping.vault_folder);
  const relative = path.relative(vaultRoot, memoryRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    warnings.push('Project memory folder resolves outside the configured vault and was skipped.');
    return [];
  }
  const files = await collectTextFiles(memoryRoot);
  const items: ContextPackItem[] = [];
  for (const filePath of files.slice(0, 60)) {
    const loaded = await readTextFile(filePath);
    if (!loaded) continue;
    const score = scoreText(loaded.text, terms) + scoreText(path.basename(filePath), terms) * 2;
    if (score <= 0) continue;
    const relativePath = path.relative(vaultRoot, filePath).split(path.sep).join('/');
    items.push({ kind: 'memory', uri: `obsidian://${relativePath}`, title: relativePath, excerpt: excerptAtRelevantLine(loaded.text, terms, 1800), score: score + 0.5, freshAt: loaded.mtime });
  }
  return items;
}

function buildTaskItem(projectId: string, taskId: string, goal: string, warnings: string[]): ContextPackItem | null {
  const task = kanbanDb.getTask(taskId);
  if (!task) {
    warnings.push(`Kanban task ${taskId} was not found.`);
    return null;
  }
  if (task.project_id !== projectId) warnings.push(`Kanban task ${taskId} belongs to another project.`);
  const comments = kanbanDb.listCommentsByTask(taskId, 20).map((comment) => `- ${comment.author ?? comment.author_type}: ${comment.body}`).join('\n');
  return {
    kind: 'task',
    uri: `kanban://tasks/${taskId}`,
    title: task.title,
    excerpt: [task.description, task.prompt ? `Prompt:\n${task.prompt}` : '', task.dependsOn.length ? `Dependencies: ${task.dependsOn.join(', ')}` : '', comments ? `Comments:\n${comments}` : ''].filter(Boolean).join('\n\n').slice(0, 7000),
    score: 100 + scoreText(`${task.title} ${task.description} ${goal}`, tokenize(goal)),
    freshAt: task.updated_at,
  };
}

async function buildRunItems(projectId: string, terms: string[]): Promise<ContextPackItem[]> {
  return runService.list({ projectId, limit: 20 }).runs.map((run) => ({
    kind: 'run_summary' as const,
    uri: `cloudcli://runs/${run.run_id}`,
    title: run.title || `${run.source} run ${run.run_id}`,
    excerpt: [`Status: ${run.status}`, `Provider: ${run.provider ?? 'unknown'}`, run.error_summary ? `Error: ${run.error_summary}` : 'No recorded error.', `Started: ${run.started_at ?? 'not started'}`].join('\n'),
    score: scoreText(`${run.title ?? ''} ${run.source} ${run.error_summary ?? ''}`, terms) + (run.status === 'succeeded' ? 1 : 2),
    freshAt: run.finished_at ?? run.created_at,
  }));
}

export async function compileContextPack(input: {
  projectId: string;
  goal: string;
  taskId?: string;
  budgetTokens?: number;
  runId?: string;
}): Promise<ContextPack> {
  const goal = input.goal.trim();
  if (!goal) throw new AppError('goal is required', { code: 'CONTEXT_PACK_GOAL_REQUIRED', statusCode: 400 });
  const projectPath = projectPathForId(input.projectId);
  const budgetTokens = Math.min(Math.max(Math.trunc(input.budgetTokens ?? DEFAULT_BUDGET), 256), MAX_BUDGET);
  const warnings: string[] = [];
  const terms = tokenize(goal);
  const candidates: ContextPackItem[] = [];
  if (input.taskId) {
    const taskItem = buildTaskItem(input.projectId, input.taskId, goal, warnings);
    if (taskItem) candidates.push(taskItem);
  }
  if (input.runId) {
    const run = runService.get(input.runId);
    if (!run) warnings.push(`Run ${input.runId} was not found.`);
    else candidates.push({ kind: 'run_summary', uri: `cloudcli://runs/${run.run_id}`, title: run.title || run.run_id, excerpt: JSON.stringify({ status: run.status, source: run.source, error: run.error_summary, provider: run.provider }, null, 2), score: 95, freshAt: run.updated_at });
  }

  const recent = await runGit(projectPath, ['log', '--format=%cI', '--name-only', '-n', '40']);
  const recentFiles = new Set(recent.stdout.split(/\r?\n/).filter((line) => line && !line.includes('T')));
  const files = await collectTextFiles(projectPath);
  for (const filePath of files) {
    const loaded = await readTextFile(filePath);
    if (!loaded) continue;
    const relativePath = path.relative(projectPath, filePath).split(path.sep).join('/');
    const lexical = scoreText(`${relativePath}\n${loaded.text}`, terms);
    const recency = recentFiles.has(relativePath) ? 3 : 0;
    if (lexical + recency <= 0) continue;
    candidates.push({ kind: 'file', uri: `file://${relativePath}`, title: relativePath, excerpt: excerptAtRelevantLine(loaded.text, terms), score: lexical + recency, freshAt: loaded.mtime });
  }
  candidates.push(...await collectMemoryItems(projectPath, terms, warnings));
  candidates.push(...await buildRunItems(input.projectId, terms));

  // Diff summary for the working tree (PRD §11.3 kind: diff).
  // Only when this project *is* the git root — otherwise git walks up to a
  // parent repo (e.g. CloudCLI itself) and pollutes packs for nested sandboxes.
  try {
    const toplevel = await runGit(projectPath, ['rev-parse', '--show-toplevel']);
    const isRepoRoot =
      toplevel.code === 0 &&
      path.resolve(toplevel.stdout.trim()) === path.resolve(projectPath);
    if (isRepoRoot) {
      const diff = await runGit(projectPath, ['diff', '--stat', 'HEAD']);
      if (diff.code === 0 && diff.stdout.trim()) {
        candidates.push({
          kind: 'diff',
          uri: 'git://diff/HEAD',
          title: 'Working tree diff summary',
          excerpt: diff.stdout.trim().slice(0, 4000),
          score: 8 + scoreText(diff.stdout, terms),
          freshAt: new Date().toISOString(),
        });
      }
    }
  } catch {
    // non-git projects skip
  }

  // ADR / decision notes under docs/ or Decisions/ (PRD §11.3 kind: adr).
  for (const filePath of files) {
    const relativePath = path.relative(projectPath, filePath).split(path.sep).join('/');
    const lower = relativePath.toLowerCase();
    if (
      !/(^|\/)(docs\/|decisions\/|adr\/)/.test(lower) &&
      !/adr[-_]?\d+/i.test(relativePath)
    ) {
      continue;
    }
    if (!/\.(md|mdx|txt)$/i.test(relativePath)) continue;
    const loaded = await readTextFile(filePath);
    if (!loaded) continue;
    candidates.push({
      kind: 'adr',
      uri: `file://${relativePath}`,
      title: relativePath,
      excerpt: excerptAtRelevantLine(loaded.text, terms, 1800),
      score: 6 + scoreText(`${relativePath}\n${loaded.text}`, terms),
      freshAt: loaded.mtime,
    });
  }

  // Stable order makes previews reproducible when multiple files have equal scores.
  const ranked = candidates
    .sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.uri === item.uri) === index);
  const items: ContextPackItem[] = [];
  let used = estimateTokens(`# CloudCLI Context Pack\nGoal: ${goal}`);
  for (const candidate of ranked) {
    const overhead = estimateTokens(`## ${candidate.kind}\n${candidate.title}\n${candidate.uri}`) + 12;
    const remaining = budgetTokens - used - overhead;
    if (remaining < 32) {
      warnings.push(`Budget trimmed ${ranked.length - items.length} lower-ranked context item(s).`);
      break;
    }
    const excerpt = candidate.excerpt.slice(0, remaining * 4);
    const next = { ...candidate, excerpt };
    items.push(next);
    used += overhead + estimateTokens(excerpt);
  }
  if (!items.length) warnings.push('No matching files or memory notes were found; the pack contains only the goal.');
  const markdown = buildMarkdown(goal, items, warnings);
  const estimatedTokens = estimateTokens(markdown);
  const pack = contextPacksDb.create({ project_id: input.projectId, goal, budgetTokens, estimatedTokens, items, warnings, markdown });
  if (input.runId) await attachPackToRun(pack.pack_id, input.runId);
  return pack;
}

export function getContextPack(packId: string): ContextPack {
  const pack = contextPacksDb.get(packId);
  if (!pack) throw new AppError(`Context pack not found: ${packId}`, { code: 'CONTEXT_PACK_NOT_FOUND', statusCode: 404 });
  return pack;
}

export function attachPackToRun(packId: string, runId: string): ContextPackAttachment {
  const pack = getContextPack(packId);
  const run = runService.get(runId);
  if (!run) throw new CloudError('RUN_NOT_FOUND', `Run not found: ${runId}`);
  if (run.project_id && run.project_id !== pack.project_id) throw new AppError('Context pack and run belong to different projects', { code: 'CONTEXT_PACK_PROJECT_MISMATCH', statusCode: 409 });
  const attachment = contextPacksDb.attach(packId, { runId });
  runService.appendEvent(runId, { run_id: runId, ts: new Date().toISOString(), source: 'system', type: 'pack.attached', payload: { pack_id: packId, estimated_tokens: pack.estimatedTokens } });
  return attachment;
}

export function attachPackToSession(packId: string, sessionId: string): ContextPackAttachment {
  const pack = getContextPack(packId);
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) throw new AppError(`Session not found: ${sessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  const project = projectsDb.getProjectPathById(pack.project_id);
  // Sessions store the *logical* project path: worktree roots and scratch dirs
  // are rehomed to their parent project on write. Resolve the pack's project the
  // same way so both sides of the comparison use identical normalization,
  // otherwise a pack compiled against a runtime path never matches its session.
  if (project && session.project_path) {
    const packProject = path.resolve(projectsDb.resolveProjectPathForRuntimePath(project));
    const sessionProject = path.resolve(projectsDb.resolveProjectPathForRuntimePath(session.project_path));
    if (packProject !== sessionProject) throw new AppError('Context pack and session belong to different projects', { code: 'CONTEXT_PACK_PROJECT_MISMATCH', statusCode: 409 });
  }
  return contextPacksDb.attach(packId, { sessionId });
}

export function listContextPackAttachments(packId: string): ContextPackAttachment[] {
  getContextPack(packId);
  return contextPacksDb.listAttachments(packId);
}
