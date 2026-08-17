/**
 * "Work this" — open a scoped chat from a Mission Control card.
 *
 * Jira Drafts and TL Tasks already carry enough context (ticket body, Trello
 * card, suggested path). This matches that to a CloudCLI project and returns
 * a new session + implementer prompt. Kanban is not involved.
 */

import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import type { McItem, McSection } from '@/modules/mission-control/mission-control.types.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const WORK_PROVIDERS = ['claude', 'grok', 'codex', 'cursor', 'opencode', 'kilo', 'cline', 'kimi', 'pi'] as const;

export type WorkThisMatch = {
  projectId: string;
  projectPath: string;
  name: string;
  score: number;
  reason: string;
};

export type WorkThisResult = {
  item: McItem;
  sessionId: string;
  provider: LLMProvider;
  projectId: string;
  projectPath: string;
  prompt: string;
  matchReason: string;
  candidates: WorkThisMatch[];
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBodyString(body: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(body[key]);
    if (value) return value;
  }
  return '';
}

function normalizeHaystack(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractTicketKey(item: McItem): string {
  const fromBody = readBodyString(item.body, ['ticket', 'jiraKey', 'issueKey', 'key']);
  if (fromBody) return fromBody;
  const match = `${item.title} ${item.summary}`.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match?.[1] ?? '';
}

function scoreProject(
  project: { project_id: string; project_path: string; custom_project_name: string | null },
  hints: { suggestedPath: string; ticket: string; client: string; title: string },
): WorkThisMatch | null {
  const name = project.custom_project_name || path.basename(project.project_path) || project.project_path;
  const haystack = normalizeHaystack(`${name} ${project.project_path}`);
  let score = 0;
  let reason = 'name';

  const suggested = asString(hints.suggestedPath);
  if (suggested) {
    const normalizedSuggested = suggested.replace(/\/+$/, '');
    if (project.project_path === normalizedSuggested || project.project_path.startsWith(`${normalizedSuggested}/`)) {
      return {
        projectId: project.project_id,
        projectPath: project.project_path,
        name,
        score: 100,
        reason: 'suggestedProjectPath',
      };
    }
    const suggestedName = normalizeHaystack(path.basename(normalizedSuggested));
    if (suggestedName && haystack.includes(suggestedName)) {
      score = 80;
      reason = 'suggested path name';
    }
  }

  const ticket = hints.ticket;
  const prefix = ticket.includes('-') ? ticket.split('-')[0] : '';
  if (prefix && haystack.includes(normalizeHaystack(prefix))) {
    if (score < 70) {
      score = 70;
      reason = `ticket prefix ${prefix}`;
    }
  }

  const client = normalizeHaystack(hints.client);
  if (client && haystack.includes(client) && score < 55) {
    score = 55;
    reason = `client ${hints.client}`;
  }

  const titleTokens = normalizeHaystack(hints.title)
    .split(' ')
    .filter((token) => token.length >= 4);
  let tokenHits = 0;
  for (const token of titleTokens) {
    if (haystack.includes(token)) tokenHits += 1;
  }
  if (tokenHits >= 2 && score < 40) {
    score = 40;
    reason = 'title tokens';
  }

  if (score <= 0) return null;
  return {
    projectId: project.project_id,
    projectPath: project.project_path,
    name,
    score,
    reason,
  };
}

export function matchProjectsForItem(item: McItem, section: McSection | null): WorkThisMatch[] {
  if (section?.scope === 'project' && section.project_id) {
    const scoped = projectsDb.getProjectById(section.project_id);
    if (scoped && !scoped.isArchived) {
      return [{
        projectId: scoped.project_id,
        projectPath: scoped.project_path,
        name: scoped.custom_project_name || path.basename(scoped.project_path),
        score: 100,
        reason: 'section project',
      }];
    }
  }

  const hints = {
    suggestedPath: readBodyString(item.body, ['suggestedProjectPath', 'projectPath', 'path']),
    ticket: extractTicketKey(item),
    client: readBodyString(item.body, ['client']),
    title: item.title,
  };

  const matches = projectsDb
    .getProjectPaths()
    .map((project) => scoreProject(project, hints))
    .filter((row): row is WorkThisMatch => row !== null)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  return matches;
}

export function buildWorkThisPrompt(item: McItem, section: McSection | null): string {
  const explicit = readBodyString(item.body, ['prompt', 'whatNeedsToBeDone']);
  const description = readBodyString(item.body, ['description']);
  const url = readBodyString(item.body, ['url', 'trelloUrl', 'jiraUrl']);
  const ticket = extractTicketKey(item);
  const actionItems = Array.isArray(item.body.actionItems)
    ? item.body.actionItems.filter((row): row is string => typeof row === 'string' && row.trim().length > 0)
    : [];

  const lines = [
    `Work this ${section?.title || 'Mission Control'} item.`,
    '',
    `## ${item.title}`,
    item.summary ? item.summary : '',
    ticket ? `Ticket: ${ticket}` : '',
    url ? `URL: ${url}` : '',
    '',
    explicit ? `## Brief\n\n${explicit}` : '',
    description && description !== explicit ? `## Description\n\n${description}` : '',
    actionItems.length > 0 ? `## Action items\n\n${actionItems.map((row) => `- ${row}`).join('\n')}` : '',
    '',
    'Start by confirming the repo and the smallest change that ships this. Do not file extra tickets unless asked.',
  ];
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n').trim();
}

function resolveProvider(item: McItem, section: McSection | null): LLMProvider {
  const fromItem = asString(item.provider);
  if ((WORK_PROVIDERS as readonly string[]).includes(fromItem)) {
    return fromItem as LLMProvider;
  }
  const fromSection = asString(section?.provider);
  if ((WORK_PROVIDERS as readonly string[]).includes(fromSection)) {
    return fromSection as LLMProvider;
  }
  return 'claude';
}

export function workThisItem(itemId: string, projectId?: string): WorkThisResult {
  const item = missionControlDb.getItem(itemId);
  if (!item) {
    throw new AppError('Item not found', { code: 'MC_ITEM_NOT_FOUND', statusCode: 404 });
  }
  if (item.status !== 'pending' && item.status !== 'failed') {
    throw new AppError(`Item is '${item.status}', not actionable`, {
      code: 'MC_ITEM_NOT_ACTIONABLE',
      statusCode: 400,
    });
  }

  const section = missionControlDb.getSection(item.section_id);
  const candidates = matchProjectsForItem(item, section);
  const chosen = projectId
    ? candidates.find((row) => row.projectId === projectId) ?? (() => {
      const forced = projectsDb.getProjectById(projectId);
      if (!forced || forced.isArchived) {
        throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      }
      return {
        projectId: forced.project_id,
        projectPath: forced.project_path,
        name: forced.custom_project_name || path.basename(forced.project_path),
        score: 1,
        reason: 'explicit',
      } satisfies WorkThisMatch;
    })()
    : candidates[0];

  if (!chosen) {
    throw new AppError(
      'Could not match this card to a project. Pick a project and try again.',
      { code: 'MC_WORK_NO_PROJECT', statusCode: 409 },
    );
  }

  const provider = resolveProvider(item, section);
  const created = sessionsService.createAppSession(provider, chosen.projectPath);
  return {
    item,
    sessionId: created.sessionId,
    provider,
    projectId: chosen.projectId,
    projectPath: created.projectPath,
    prompt: buildWorkThisPrompt(item, section),
    matchReason: chosen.reason,
    candidates: candidates.slice(0, 6),
  };
}
