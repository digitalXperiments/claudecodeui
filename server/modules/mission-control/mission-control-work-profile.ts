import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { isMcProvider, type McItem, type McWorkProfile } from './mission-control.types.js';

export const normalizeClient = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function invalid(message: string): never {
  throw new AppError(message, { code: 'MC_INVALID_WORK_PROFILE', statusCode: 400 });
}

export function parseWorkProfile(value: unknown): McWorkProfile | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Work profile must be an object.');
  const row = value as Record<string, unknown>;
  if (!isMcProvider(row.provider)) invalid('Select a work-session agent.');
  if (typeof row.auto_start !== 'boolean') invalid('auto_start must be a boolean.');
  if (typeof row.model !== 'string' || !row.model.trim()) invalid('Select a work-session model.');
  if (row.effort != null && (typeof row.effort !== 'string' || !row.effort.trim())) invalid('Effort must be a level name or empty.');
  if (!Array.isArray(row.mcp_servers) || row.mcp_servers.some((s) => typeof s !== 'string' || !s.trim())) invalid('Work-session MCP servers must be names.');
  if (typeof row.context !== 'string') invalid('Work context must be text.');
  if (row.routes !== undefined && !Array.isArray(row.routes)) invalid('Client mappings must be a list.');
  const defaultProjectId = typeof row.default_project_id === 'string' && row.default_project_id.trim() ? row.default_project_id.trim() : null;
  if (row.default_project_id != null && typeof row.default_project_id !== 'string') invalid('Default project must be a project id.');
  if (defaultProjectId) {
    const project = projectsDb.getProjectById(defaultProjectId);
    if (!project || project.isArchived) invalid('Default project is missing or archived.');
  }
  const rawRoutes = (row.routes ?? []) as unknown[];
  if (!rawRoutes.length && !defaultProjectId) invalid('Select a default project or add a client mapping.');
  const seen = new Set<string>();
  const routes = rawRoutes.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') invalid('Invalid client mapping.');
    const route = entry as Record<string, unknown>;
    if (typeof route.client !== 'string' || !normalizeClient(route.client)) invalid('Client name is required.');
    if (!Array.isArray(route.aliases) || route.aliases.some((alias) => typeof alias !== 'string' || !normalizeClient(alias))) invalid('Aliases must be nonempty names.');
    for (const name of [route.client, ...route.aliases as string[]]) {
      const key = normalizeClient(name);
      if (seen.has(key)) invalid(`Duplicate client or alias: ${name}`);
      seen.add(key);
    }
    if (typeof route.project_id !== 'string') invalid('Select a project for each client.');
    const project = projectsDb.getProjectById(route.project_id);
    if (!project || project.isArchived) invalid(`Project for ${route.client} is missing or archived.`);
    if (typeof route.context !== 'string') invalid('Client context must be text.');
    return { client: route.client.trim(), aliases: route.aliases as string[], project_id: route.project_id, context: route.context };
  });
  return { auto_start: row.auto_start, provider: row.provider, model: row.model.trim(), effort: typeof row.effort === 'string' ? row.effort.trim() : null, mcp_servers: [...new Set((row.mcp_servers as string[]).map((s) => s.trim()))], context: row.context, default_project_id: defaultProjectId, routes };
}

/**
 * Project for an item: an explicit operator choice wins, then a unique client
 * mapping, then the profile's default project.
 */
export function routeWorkItem(item: McItem, profile: McWorkProfile, overrideProjectId?: string): { client: string; project_id: string; context: string } {
  const rawClient = typeof item.body.client === 'string' ? item.body.client.trim() : '';
  const client = normalizeClient(rawClient);
  const matches = client ? profile.routes.filter((route) => [route.client, ...route.aliases].some((name) => normalizeClient(name) === client)) : [];
  const route = matches.length === 1 ? matches[0] : null;
  if (overrideProjectId) {
    return { client: route?.client ?? rawClient, project_id: overrideProjectId, context: route?.project_id === overrideProjectId ? route.context : '' };
  }
  if (route) return route;
  if (profile.default_project_id) return { client: rawClient, project_id: profile.default_project_id, context: '' };
  throw new AppError(`No unique client mapping for "${rawClient}". Set the item's client, add a client mapping, or choose a default project.`, { code: 'MC_WORK_NO_PROJECT', statusCode: 409 });
}
