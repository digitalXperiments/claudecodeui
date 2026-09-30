import { MC_PROVIDERS, type McProvider, type McWorkProfile } from '../../../mission-control/api/missionControlApi';
import type { Bot } from '../../types';

const isMcProvider = (value: string): value is McProvider => (MC_PROVIDERS as readonly string[]).includes(value);
export const emptyWorkProfile = (bot: Pick<Bot, 'provider'>): McWorkProfile => ({ auto_start: false, provider: isMcProvider(bot.provider) ? bot.provider : 'claude', model: '', effort: null, mcp_servers: [], context: '', default_project_id: null, routes: [] });
export const loadWorkProfile = (bot: Pick<Bot, 'provider' | 'work_profile'>): McWorkProfile => (bot.work_profile ? { ...bot.work_profile, effort: bot.work_profile.effort ?? null, default_project_id: bot.work_profile.default_project_id ?? null, routes: bot.work_profile.routes ?? [] } : emptyWorkProfile(bot));

/** Normalizes a profile for saving (trimmed aliases), or explains why it cannot be saved. */
export function prepareWorkProfile(profile: McWorkProfile): { profile: McWorkProfile; error: string | null } {
  const error = !profile.model ? 'Select a work-session model.' : !profile.default_project_id && !profile.routes.length ? 'Select a default project or add a client mapping.' : null;
  return { profile: { ...profile, routes: profile.routes.map((route) => ({ ...route, aliases: route.aliases.map((alias) => alias.trim()).filter(Boolean) })) }, error };
}
