import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';
import { enqueueTask } from '@/modules/kanban/index.js';
import { isKanbanProvider, type KanbanTaskTools } from '@/modules/kanban/index.js';
import { AppError } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';
import type {
  DeliveryGraph,
  DeliveryGraphAcceptanceCriterion,
  DeliveryGraphApplyResult,
  DeliveryGraphRequirement,
  DeliveryGraphTask,
  TaskMasterImportItem,
  TaskMasterImportReport,
} from '@/modules/delivery-graph/delivery-graph.types.js';

type MarkdownItem = { text: string; section: string; line: number };

function requireProjectPath(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new AppError(`Project not found: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
  return path.resolve(projectPath);
}

/** Resolve a project-relative path while rejecting traversal and symlinked escapes. */
async function resolveProjectFile(projectId: string, requestedPath: string): Promise<{
  projectPath: string;
  absolutePath: string;
  relativePath: string;
}> {
  const projectPath = requireProjectPath(projectId);
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    throw new AppError('prdPath/path is required', {
      code: 'DELIVERY_GRAPH_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const absolutePath = path.resolve(projectPath, trimmed);
  const relativePath = path.relative(projectPath, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new AppError('Path must stay inside the project directory', {
      code: 'DELIVERY_GRAPH_PATH_OUTSIDE_PROJECT',
      statusCode: 400,
    });
  }

  let fileStats;
  try {
    fileStats = await stat(absolutePath);
  } catch {
    throw new AppError(`File not found: ${trimmed}`, {
      code: 'DELIVERY_GRAPH_FILE_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (!fileStats.isFile()) {
    throw new AppError(`Path is not a file: ${trimmed}`, {
      code: 'DELIVERY_GRAPH_NOT_A_FILE',
      statusCode: 400,
    });
  }

  // A symlink can make a lexical containment check insufficient. Resolve the
  // file and ensure the real target remains within the registered project.
  try {
    const realProject = await import('node:fs/promises').then(({ realpath }) => realpath(projectPath));
    const realFile = await import('node:fs/promises').then(({ realpath }) => realpath(absolutePath));
    const realRelative = path.relative(realProject, realFile);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new AppError('File resolves outside the project directory', {
        code: 'DELIVERY_GRAPH_PATH_OUTSIDE_PROJECT',
        statusCode: 400,
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Unable to validate PRD path', {
      code: 'DELIVERY_GRAPH_PATH_INVALID',
      statusCode: 400,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  return { projectPath, absolutePath, relativePath: relativePath || path.basename(absolutePath) };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'delivery-task';
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBullet(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?/.test(line);
}

function bulletText(line: string): string {
  return cleanMarkdown(
    line
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?/, '')
      .replace(/\s+#+\s*$/, ''),
  );
}

function parseMarkdown(content: string): {
  title: string;
  requirements: DeliveryGraphRequirement[];
  acceptanceCriteria: DeliveryGraphAcceptanceCriterion[];
  taskSeeds: Array<{ title: string; section: string; details: string[] }>;
} {
  const lines = content.split(/\r?\n/);
  const title = cleanMarkdown(lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '') ?? 'Delivery graph');
  let section = title;
  let sectionLevel = 1;
  const bullets: MarkdownItem[] = [];
  const headings: Array<{ title: string; level: number; line: number }> = [];

  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      sectionLevel = heading[1].length;
      section = cleanMarkdown(heading[2]);
      headings.push({ title: section, level: sectionLevel, line: index });
      return;
    }
    if (isBullet(line)) {
      bullets.push({ text: bulletText(line), section, line: index });
    }
  });

  const isAcceptanceSection = (value: string): boolean =>
    /acceptance|success criteria|done when|definition of done/i.test(value);
  const isRequirementSection = (value: string): boolean =>
    /requirement|goal|objective|scope|must|feature/i.test(value);
  const isNonTaskSection = (value: string): boolean =>
    /requirement|acceptance|success criteria|done when|definition of done|table of contents|appendix|change log/i.test(value);

  const requirementItems = bullets.filter((item) => isRequirementSection(item.section) && !isAcceptanceSection(item.section));
  const acceptanceItems = bullets.filter((item) => isAcceptanceSection(item.section));
  const requirements: DeliveryGraphRequirement[] = (requirementItems.length > 0 ? requirementItems : bullets.slice(0, 12))
    .filter((item) => item.text.length > 2)
    .map((item, index) => ({ id: `req-${index + 1}`, text: item.text, priority: index + 1 }));
  const acceptanceCriteria: DeliveryGraphAcceptanceCriterion[] = acceptanceItems
    .filter((item) => item.text.length > 2)
    .map((item, index) => ({ id: `ac-${index + 1}`, text: item.text, reqIds: requirements.length ? [requirements[Math.min(index, requirements.length - 1)].id] : [] }));

  const taskHeadings = headings.filter(
    (heading) => heading.level >= 2 && !isNonTaskSection(heading.title) && heading.title.length > 2,
  );
  const taskSeeds: Array<{ title: string; section: string; details: string[] }> = [];
  for (let index = 0; index < taskHeadings.length; index += 1) {
    const heading = taskHeadings[index];
    const nextHeadingLine = taskHeadings[index + 1]?.line ?? lines.length;
    const details = bullets
      .filter((item) => item.line > heading.line && item.line < nextHeadingLine)
      .map((item) => item.text)
      .filter(Boolean);
    taskSeeds.push({ title: heading.title, section: heading.title, details });
  }

  if (taskSeeds.length === 0) {
    const fallback = requirements.length > 0
      ? requirements
      : [{ id: 'req-1', text: title } satisfies DeliveryGraphRequirement];
    fallback.forEach((requirement) => {
      taskSeeds.push({ title: requirement.text, section: 'Requirements', details: [] });
    });
  }

  return { title, requirements, acceptanceCriteria, taskSeeds };
}

function buildGraphFromMarkdown(
  content: string,
  prdPath: string,
  provider?: string,
): DeliveryGraph {
  const parsed = parseMarkdown(content);
  const defaultProvider = provider && isKanbanProvider(provider) ? provider : undefined;
  const tasks: DeliveryGraphTask[] = parsed.taskSeeds.map((seed, index) => {
    const reqIds = parsed.requirements.length
      ? [parsed.requirements[Math.min(index, parsed.requirements.length - 1)].id]
      : [];
    const acceptanceIds = parsed.acceptanceCriteria.length
      ? parsed.acceptanceCriteria
          .filter((criterion) => !criterion.reqIds?.length || criterion.reqIds.some((id) => reqIds.includes(id)))
          .map((criterion) => criterion.id)
      : [];
    const detailText = seed.details.length ? `\n\nSource notes:\n${seed.details.map((item) => `- ${item}`).join('\n')}` : '';
    const acceptanceText = acceptanceIds.length
      ? `\n\nAcceptance criteria:\n${acceptanceIds.map((id) => `- ${parsed.acceptanceCriteria.find((criterion) => criterion.id === id)?.text ?? id}`).join('\n')}`
      : '';
    const description = `Implement ${seed.title}.${detailText}${acceptanceText}`;
    return {
      tempId: `task-${index + 1}`,
      title: seed.title,
      description,
      prompt: `Implement “${seed.title}” from ${prdPath}. Preserve existing behavior, satisfy the linked requirements and acceptance criteria, and add or update focused tests. Done when the implementation is verified and the working tree is clean apart from intentional changes.`,
      reqIds,
      acceptanceIds,
      dependsOn: [],
      estimateMinutes: Math.max(30, Math.min(480, 30 + seed.details.length * 20)),
      assigneeProvider: defaultProvider,
      labels: ['prd', `section:${slugify(seed.section)}`],
      suggestedBranch: `feat/${slugify(seed.title)}`,
    };
  });

  return {
    version: 1,
    prdPath,
    title: parsed.title,
    requirements: parsed.requirements,
    acceptanceCriteria: parsed.acceptanceCriteria,
    tasks,
    schedule: { strategy: 'asap' },
  };
}

export async function generateDeliveryGraph(input: {
  projectId: string;
  prdPath: string;
  provider?: string;
}): Promise<{ graph: DeliveryGraph; sourcePath: string; generator: string }> {
  const resolved = await resolveProjectFile(input.projectId, input.prdPath);
  const content = await readFile(resolved.absolutePath, 'utf8');
  if (!content.trim()) {
    throw new AppError('PRD file is empty', { code: 'DELIVERY_GRAPH_EMPTY_PRD', statusCode: 400 });
  }
  return {
    graph: buildGraphFromMarkdown(content, resolved.relativePath, input.provider),
    sourcePath: resolved.relativePath,
    generator: 'markdown-structured-v1',
  };
}

function graphMarker(prdPath: string, tempId: string): string {
  return `[cloudcli:delivery-graph:${prdPath}:${tempId}]`;
}

function providerOrNull(value: string | undefined): LLMProvider | null {
  return value && isKanbanProvider(value) ? value : null;
}

function validateGraph(graph: DeliveryGraph): void {
  if (!graph || graph.version !== 1 || !Array.isArray(graph.tasks)) {
    throw new AppError('graph must be a version 1 delivery graph', {
      code: 'DELIVERY_GRAPH_INVALID',
      statusCode: 400,
    });
  }
  const ids = new Set<string>();
  for (const task of graph.tasks) {
    if (!task || typeof task.tempId !== 'string' || !task.tempId.trim() || ids.has(task.tempId)) {
      throw new AppError('Every graph task must have a unique tempId', {
        code: 'DELIVERY_GRAPH_INVALID_TASK',
        statusCode: 400,
      });
    }
    if (!task.title?.trim()) {
      throw new AppError(`Graph task ${task.tempId} requires a title`, {
        code: 'DELIVERY_GRAPH_INVALID_TASK',
        statusCode: 400,
      });
    }
    ids.add(task.tempId);
  }
  for (const task of graph.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new AppError(`Graph task ${task.tempId} depends on unknown task ${dependency}`, {
          code: 'DELIVERY_GRAPH_UNKNOWN_DEPENDENCY',
          statusCode: 400,
        });
      }
    }
  }
}

export function applyDeliveryGraph(input: {
  projectId: string;
  graph: DeliveryGraph;
  boardId?: string;
  startReady?: boolean;
}): DeliveryGraphApplyResult {
  validateGraph(input.graph);
  const board = input.boardId ? kanbanDb.getBoard(input.boardId) : kanbanDb.getOrCreateGlobalBoard();
  if (!board) {
    throw new AppError(`Board not found: ${input.boardId}`, {
      code: 'KANBAN_BOARD_NOT_FOUND',
      statusCode: 404,
    });
  }

  const result: DeliveryGraphApplyResult = {
    boardId: board.board_id,
    created: [],
    reused: [],
    dependencies: [],
    queued: [],
    warnings: [],
  };
  const taskIds = new Map<string, string>();

  for (const graphTask of input.graph.tasks) {
    const marker = graphMarker(input.graph.prdPath, graphTask.tempId);
    const existing = kanbanDb.findTaskByTextMarkers(board.board_id, [marker]);
    if (existing) {
      taskIds.set(graphTask.tempId, existing.task_id);
      result.reused.push({ tempId: graphTask.tempId, taskId: existing.task_id, title: existing.title });
      continue;
    }
    const tools: KanbanTaskTools = {
      labels: graphTask.labels ?? [],
      requirements: graphTask.reqIds ?? [],
      acceptanceCriteria: graphTask.acceptanceIds ?? [],
      mcps: input.graph.mcps ?? [],
      skills: input.graph.skills ?? [],
    };
    const description = `${graphTask.description ?? ''}\n\n${marker}`.trim();
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: input.projectId,
      title: graphTask.title.trim(),
      description,
      prompt: graphTask.prompt?.trim() || description,
      assigneeProvider: providerOrNull(graphTask.assigneeProvider),
      reviewProvider: providerOrNull(graphTask.reviewProvider),
      implementProfileId: graphTask.implementProfileId ?? null,
      reviewProfileId: graphTask.reviewProfileId ?? null,
      permissionMode: graphTask.permissionMode,
      featureBranch: graphTask.suggestedBranch ?? null,
      tools,
    });
    taskIds.set(graphTask.tempId, task.task_id);
    result.created.push({ tempId: graphTask.tempId, taskId: task.task_id, title: task.title });
  }

  for (const graphTask of input.graph.tasks) {
    const taskId = taskIds.get(graphTask.tempId);
    if (!taskId) continue;
    for (const dependency of graphTask.dependsOn ?? []) {
      const dependsOnTaskId = taskIds.get(dependency);
      if (!dependsOnTaskId) {
        result.warnings.push(`Could not map dependency ${dependency} for ${graphTask.tempId}`);
        continue;
      }
      try {
        kanbanDb.addDependency(taskId, dependsOnTaskId);
        result.dependencies.push({ taskId, dependsOnTaskId });
      } catch (error) {
        result.warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (input.startReady) {
    for (const graphTask of input.graph.tasks) {
      if ((graphTask.dependsOn ?? []).length > 0) continue;
      const taskId = taskIds.get(graphTask.tempId);
      if (!taskId) continue;
      const before = kanbanDb.getTask(taskId);
      enqueueTask(taskId, 'manual');
      const after = kanbanDb.getTask(taskId);
      if (before?.status !== 'queued' && (after?.status === 'queued' || after?.status === 'running')) {
        result.queued.push(taskId);
      }
    }
  }
  return result;
}

function taskStatusMapping(status: string | undefined): { columnId: string; status: 'todo' | 'blocked' | 'done' } {
  const normalized = (status ?? 'pending').toLowerCase().replace(/[_ ]/g, '-');
  if (['done', 'completed', 'complete'].includes(normalized)) return { columnId: 'done', status: 'done' };
  if (normalized === 'review') return { columnId: 'review', status: 'todo' };
  if (['in-progress', 'running', 'started'].includes(normalized)) return { columnId: 'in_progress', status: 'todo' };
  if (['blocked', 'deferred', 'cancelled', 'canceled'].includes(normalized)) return { columnId: 'backlog', status: 'blocked' };
  return { columnId: 'backlog', status: 'todo' };
}

function flattenTaskMasterTasks(tasks: TaskMasterImportItem[], parentSourceId?: string): TaskMasterImportItem[] {
  const flattened: TaskMasterImportItem[] = [];
  for (const task of tasks) {
    const sourceId = parentSourceId ? `${parentSourceId}.${String(task.id)}` : String(task.id);
    const copy = { ...task, id: sourceId, parentId: parentSourceId ?? task.parentId };
    flattened.push(copy);
    if (Array.isArray(task.subtasks)) {
      flattened.push(...flattenTaskMasterTasks(task.subtasks, sourceId));
    }
  }
  return flattened;
}

function extractTaskMasterTasks(parsed: unknown): TaskMasterImportItem[] {
  if (Array.isArray(parsed)) return parsed as TaskMasterImportItem[];
  if (!parsed || typeof parsed !== 'object') return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.tasks)) return record.tasks as TaskMasterImportItem[];
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).tasks)) {
      return (value as Record<string, unknown>).tasks as TaskMasterImportItem[];
    }
  }
  return [];
}

export async function importTaskMasterTasks(input: {
  projectId: string;
  boardId: string;
  requestedPath?: string;
  dryRun?: boolean;
  assigneeProvider?: string;
  reviewProvider?: string;
}): Promise<TaskMasterImportReport> {
  const resolved = await resolveProjectFile(input.projectId, input.requestedPath?.trim() || '.taskmaster/tasks/tasks.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved.absolutePath, 'utf8'));
  } catch (error) {
    throw new AppError('Failed to parse TaskMaster tasks file', {
      code: 'TASKMASTER_IMPORT_INVALID_JSON',
      statusCode: 400,
      details: error instanceof Error ? error.message : String(error),
    });
  }
  const board = kanbanDb.getBoard(input.boardId);
  if (!board) {
    throw new AppError(`Board not found: ${input.boardId}`, { code: 'KANBAN_BOARD_NOT_FOUND', statusCode: 404 });
  }
  const tasks = flattenTaskMasterTasks(extractTaskMasterTasks(parsed));
  const report: TaskMasterImportReport = {
    projectId: input.projectId,
    boardId: board.board_id,
    sourcePath: resolved.relativePath,
    dryRun: Boolean(input.dryRun),
    total: tasks.length,
    wouldCreate: 0,
    created: [],
    existing: [],
    dependencies: [],
    dependencyWarnings: [],
    warnings: [],
  };
  const sourceToTaskId = new Map<string, string>();
  const taskBySourceId = new Map(tasks.map((task) => [String(task.id), task]));

  for (const sourceTask of tasks) {
    const sourceId = String(sourceTask.id);
    const title = String(sourceTask.title ?? '').trim() || `TaskMaster task ${sourceId}`;
    if (!String(sourceTask.title ?? '').trim()) report.warnings.push(`Task ${sourceId} had no title; a fallback title was used.`);
    const marker = `[cloudcli:taskmaster:${sourceId}]`;
    const existing = kanbanDb.findTaskByTextMarkers(board.board_id, [marker]);
    if (existing) {
      sourceToTaskId.set(sourceId, existing.task_id);
      report.existing.push({ sourceId, taskId: existing.task_id, title: existing.title });
      continue;
    }
    report.wouldCreate += 1;
    if (report.dryRun) {
      report.created.push({ sourceId, title });
      continue;
    }

    const mapped = taskStatusMapping(typeof sourceTask.status === 'string' ? sourceTask.status : undefined);
    const descriptionParts = [
      sourceTask.description,
      sourceTask.details ? `Details:\n${sourceTask.details}` : '',
      sourceTask.testStrategy ? `Test strategy:\n${sourceTask.testStrategy}` : '',
      `TaskMaster source id: ${sourceId}`,
      marker,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const tools: KanbanTaskTools = {
      taskmasterSource: {
        id: sourceId,
        priority: sourceTask.priority ?? null,
        status: sourceTask.status ?? null,
        parentId: sourceTask.parentId ?? null,
        raw: sourceTask,
      },
    };
    const created = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: input.projectId,
      title,
      description: descriptionParts.join('\n\n'),
      prompt: `Implement TaskMaster task ${sourceId}: ${title}.\n\n${sourceTask.details ?? sourceTask.description ?? ''}\n\nVerify with: ${sourceTask.testStrategy ?? 'the project test suite'}.`,
      columnId: mapped.columnId,
      assigneeProvider: providerOrNull(input.assigneeProvider),
      reviewProvider: providerOrNull(input.reviewProvider),
      tools,
    });
    if (mapped.status !== 'todo') kanbanDb.setTaskStatus(created.task_id, mapped.status);
    sourceToTaskId.set(sourceId, created.task_id);
    report.created.push({ sourceId, taskId: created.task_id, title });
  }

  if (!report.dryRun) {
    for (const sourceTask of tasks) {
      const taskId = sourceToTaskId.get(String(sourceTask.id));
      if (!taskId) continue;
      for (const rawDependency of sourceTask.dependencies ?? []) {
        const dependencyId = String(rawDependency);
        const dependsOnTaskId = sourceToTaskId.get(dependencyId);
        if (!dependsOnTaskId) {
          report.dependencyWarnings.push(`Task ${sourceTask.id} depends on missing TaskMaster task ${dependencyId}`);
          continue;
        }
        try {
          kanbanDb.addDependency(taskId, dependsOnTaskId);
          report.dependencies.push({ sourceId: String(sourceTask.id), dependsOnSourceId: dependencyId, taskId, dependsOnTaskId });
        } catch (error) {
          report.dependencyWarnings.push(error instanceof Error ? error.message : String(error));
        }
      }
      const parentId = typeof sourceTask.parentId === 'string' ? sourceTask.parentId : sourceTask.parentId != null ? String(sourceTask.parentId) : null;
      if (parentId && taskBySourceId.has(parentId) && sourceToTaskId.has(parentId)) {
        try {
          kanbanDb.addDependency(taskId, sourceToTaskId.get(parentId)!);
          report.dependencies.push({ sourceId: String(sourceTask.id), dependsOnSourceId: parentId, taskId, dependsOnTaskId: sourceToTaskId.get(parentId) });
        } catch (error) {
          report.dependencyWarnings.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } else {
    for (const sourceTask of tasks) {
      for (const rawDependency of sourceTask.dependencies ?? []) {
        const dependencyId = String(rawDependency);
        if (!taskBySourceId.has(dependencyId)) report.dependencyWarnings.push(`Task ${sourceTask.id} depends on missing TaskMaster task ${dependencyId}`);
      }
    }
  }
  return report;
}
