/**
 * Typed client for the Bot Runtime v2 REST surface (server/modules/bots/*.routes.ts), all under
 * /api/bots. One function per endpoint, grouped by area. Errors are thrown as readable `Error`s
 * (the server answers `{ success: false, error: { code, message } }`, or `{ error: string }` on
 * a few public routes; both are understood).
 *
 * Provisional: `exec` (E1: exec/exec.routes.ts) is coded from the planned paths and may need
 * adjusting when that router lands. `collab` mirrors collab/collab.routes.ts as written by E2.
 */

import { authenticatedFetch } from '../../../utils/api';
import type {
  BotBrief,
  BotBudget,
  BotBudgetInput,
  BotBudgetStatus,
  BotChannel,
  BotChannelInput,
  BotChannelList,
  BotChannelPatch,
  BotCommitment,
  BotCommitmentInput,
  BotCommitmentStatus,
  BotCredentialName,
  BotEnforcement,
  BotEpisode,
  BotEpisodeDetail,
  BotEpisodeSearchHit,
  BotEpisodeStatus,
  BotEvent,
  BotGateDecisionFilter,
  BotGateDecisionView,
  BotGoal,
  BotGoalInput,
  BotGoalPatch,
  BotGoalStatus,
  BotOperatorProfileEntry,
  BotOutboundLogEntry,
  BotPeers,
  BotProposal,
  BotPurgeCounts,
  BotPurgeSelection,
  BotRiskPreview,
  BotRule,
  BotRuleInput,
  BotRulePatch,
  BotRuleResult,
  BotRuntimeConfig,
  BotRuntimeConfigPatch,
  BotRuntimeHost,
  BotRuntimeStatus,
  BotShadowCandidate,
  BotShadowJob,
  BotSkill,
  BotSkillSaveInput,
  BotSpace,
  BotSpaceContent,
  BotTeachState,
  BotTeam,
  BotTeamInput,
  BotThreadMessage,
  BotTrigger,
  CompiledSchedule,
} from '../types/botRuntime';

const BASE = '/api/bots';

const seg = (value: string): string => encodeURIComponent(value);

/** Build `?a=1&b=2`, skipping undefined/empty values. */
export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Pull a human message out of any error envelope the bots routers produce. */
export function errorMessageFromPayload(payload: unknown, status: number): string {
  const record = (payload && typeof payload === 'object' ? payload : {}) as {
    error?: string | { message?: string };
    message?: string;
  };
  const error = typeof record.error === 'string' ? record.error : record.error?.message;
  return error || record.message || `Request failed (${status})`;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessageFromPayload(payload, response.status));
  return payload as T;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await authenticatedFetch(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return readJson<T>(response);
}

const get = <T>(path: string) => call<T>('GET', path);
const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {});
const put = <T>(path: string, body?: unknown) => call<T>('PUT', path, body ?? {});
const patch = <T>(path: string, body?: unknown) => call<T>('PATCH', path, body ?? {});
const del = <T>(path: string) => call<T>('DELETE', path);

const bot = (botId: string): string => `/${seg(botId)}`;

export const botRuntimeApi = {
  // ---- runtime status + per-bot config ---------------------------------------------------------
  runtime: {
    status: (): Promise<BotRuntimeStatus> => get('/runtime/status'),
    async getConfig(botId: string): Promise<BotRuntimeConfig> {
      return (await get<{ runtime: BotRuntimeConfig }>(`${bot(botId)}/runtime`)).runtime;
    },
    async patchConfig(botId: string, update: BotRuntimeConfigPatch): Promise<BotRuntimeConfig> {
      return (await patch<{ runtime: BotRuntimeConfig }>(`${bot(botId)}/runtime`, update)).runtime;
    },
    async enforcement(botId: string): Promise<BotEnforcement> {
      return (await get<{ enforcement: BotEnforcement }>(`${bot(botId)}/enforcement`)).enforcement;
    },
  },

  // ---- triggers ---------------------------------------------------------------------------------
  triggers: {
    async list(botId: string): Promise<BotTrigger[]> {
      return (await get<{ triggers: BotTrigger[] }>(`${bot(botId)}/triggers`)).triggers;
    },
    async create(botId: string, input: { kind: string; config?: Record<string, unknown>; enabled?: boolean }): Promise<BotTrigger> {
      return (await post<{ trigger: BotTrigger }>(`${bot(botId)}/triggers`, input)).trigger;
    },
    async update(botId: string, triggerId: string, update: { config?: Record<string, unknown>; enabled?: boolean }): Promise<BotTrigger> {
      return (await patch<{ trigger: BotTrigger }>(`${bot(botId)}/triggers/${seg(triggerId)}`, update)).trigger;
    },
    remove: (botId: string, triggerId: string): Promise<{ ok: boolean }> => del(`${bot(botId)}/triggers/${seg(triggerId)}`),
    /** Fires a labelled sample event through the real ingest path (the bot will wake). */
    async test(botId: string, triggerId: string): Promise<BotEvent> {
      return (await post<{ event: BotEvent }>(`${bot(botId)}/triggers/${seg(triggerId)}/test`)).event;
    },
    compileSchedule: (text: string, timezone?: string): Promise<CompiledSchedule> =>
      post('/triggers/compile-schedule', { text, ...(timezone ? { timezone } : {}) }),
    /** Operator manual wake: a trust=operator `manual` event. */
    async wake(botId: string, note?: string): Promise<BotEvent> {
      return (await post<{ event: BotEvent }>(`${bot(botId)}/wake`, note ? { note } : {})).event;
    },
  },

  // ---- events -----------------------------------------------------------------------------------
  events: {
    async list(botId: string, limit = 50): Promise<BotEvent[]> {
      return (await get<{ events: BotEvent[] }>(`${bot(botId)}/events${buildQuery({ limit })}`)).events;
    },
  },

  // ---- goals ------------------------------------------------------------------------------------
  goals: {
    async list(botId: string, status?: BotGoalStatus): Promise<BotGoal[]> {
      return (await get<{ goals: BotGoal[] }>(`${bot(botId)}/goals${buildQuery({ status })}`)).goals;
    },
    async create(botId: string, input: BotGoalInput): Promise<BotGoal> {
      return (await post<{ goal: BotGoal }>(`${bot(botId)}/goals`, input)).goal;
    },
    async update(botId: string, goalId: string, update: BotGoalPatch): Promise<BotGoal> {
      return (await patch<{ goal: BotGoal }>(`${bot(botId)}/goals/${seg(goalId)}`, update)).goal;
    },
    remove: (botId: string, goalId: string): Promise<{ success: boolean }> => del(`${bot(botId)}/goals/${seg(goalId)}`),
  },

  // ---- commitments ------------------------------------------------------------------------------
  commitments: {
    async list(botId: string, status?: BotCommitmentStatus): Promise<BotCommitment[]> {
      return (await get<{ commitments: BotCommitment[] }>(`${bot(botId)}/commitments${buildQuery({ status })}`)).commitments;
    },
    async create(botId: string, input: BotCommitmentInput): Promise<BotCommitment> {
      return (await post<{ commitment: BotCommitment }>(`${bot(botId)}/commitments`, input)).commitment;
    },
    async complete(botId: string, commitmentId: string): Promise<BotCommitment> {
      return (await post<{ commitment: BotCommitment }>(`${bot(botId)}/commitments/${seg(commitmentId)}/complete`)).commitment;
    },
    async cancel(botId: string, commitmentId: string): Promise<BotCommitment> {
      return (await post<{ commitment: BotCommitment }>(`${bot(botId)}/commitments/${seg(commitmentId)}/cancel`)).commitment;
    },
  },

  // ---- episodes ---------------------------------------------------------------------------------
  episodes: {
    async list(botId: string, options: { limit?: number; status?: BotEpisodeStatus } = {}): Promise<BotEpisode[]> {
      return (await get<{ episodes: BotEpisode[] }>(`${bot(botId)}/episodes${buildQuery(options)}`)).episodes;
    },
    async search(botId: string, q: string, limit?: number): Promise<BotEpisodeSearchHit[]> {
      return (await get<{ hits: BotEpisodeSearchHit[] }>(`${bot(botId)}/episodes/search${buildQuery({ q, limit })}`)).hits;
    },
    detail: (botId: string, episodeId: string): Promise<BotEpisodeDetail> => get(`${bot(botId)}/episodes/${seg(episodeId)}`),
  },

  // ---- action gate: rules + decisions -----------------------------------------------------------
  gate: {
    /** Global rules, or that bot's own rules when `botId` is given (`includeGlobal` adds the global ones). */
    async listRules(options: { botId?: string; includeGlobal?: boolean } = {}): Promise<BotRule[]> {
      const query = buildQuery({ botId: options.botId, includeGlobal: options.includeGlobal ? 1 : undefined });
      return (await get<{ rules: BotRule[] }>(`/rules${query}`)).rules;
    },
    createRule: (input: BotRuleInput): Promise<BotRuleResult> => post('/rules', input),
    updateRule: (ruleId: string, update: BotRulePatch): Promise<BotRuleResult> => patch(`/rules/${seg(ruleId)}`, update),
    deleteRule: (ruleId: string): Promise<{ success: boolean }> => del(`/rules/${seg(ruleId)}`),
    async decisions(botId: string, filter: BotGateDecisionFilter = {}): Promise<BotGateDecisionView[]> {
      return (await get<{ decisions: BotGateDecisionView[] }>(`${bot(botId)}/gate-decisions${buildQuery(filter)}`)).decisions;
    },
    classify: (tool: string, server = ''): Promise<BotRiskPreview> => get(`/risk/classify${buildQuery({ server, tool })}`),
  },

  // ---- budget -----------------------------------------------------------------------------------
  budget: {
    async get(botId: string): Promise<BotBudget | null> {
      return (await get<{ budget: BotBudget | null }>(`${bot(botId)}/budget`)).budget;
    },
    async put(botId: string, input: BotBudgetInput): Promise<BotBudget> {
      return (await put<{ budget: BotBudget }>(`${bot(botId)}/budget`, input)).budget;
    },
    async status(botId: string): Promise<BotBudgetStatus> {
      return (await get<{ status: BotBudgetStatus }>(`${bot(botId)}/budget/status`)).status;
    },
  },

  // ---- channels + outbound log ------------------------------------------------------------------
  channels: {
    /** Global channels, or that bot's own plus `effective` (own + inherited) when `botId` is given. */
    list: (botId?: string): Promise<BotChannelList> => get(`/channels${buildQuery({ botId })}`),
    async create(input: BotChannelInput): Promise<BotChannel> {
      return (await post<{ channel: BotChannel }>('/channels', input)).channel;
    },
    async update(channelId: string, update: BotChannelPatch): Promise<BotChannel> {
      return (await patch<{ channel: BotChannel }>(`/channels/${seg(channelId)}`, update)).channel;
    },
    remove: (channelId: string): Promise<{ success: boolean }> => del(`/channels/${seg(channelId)}`),
    /** Sends a real test message. A delivery failure (HTTP 502) resolves `{ success: false, detail }` instead of throwing. */
    async test(channelId: string): Promise<{ success: boolean; detail?: string }> {
      const response = await authenticatedFetch(`${BASE}/channels/${seg(channelId)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; detail?: string };
      if (response.ok || response.status === 502) return { success: Boolean(payload.success), ...(payload.detail ? { detail: payload.detail } : {}) };
      throw new Error(errorMessageFromPayload(payload, response.status));
    },
    async outboundLog(options: { botId?: string; limit?: number } = {}): Promise<BotOutboundLogEntry[]> {
      return (await get<{ entries: BotOutboundLogEntry[] }>(`/outbound-log${buildQuery(options)}`)).entries;
    },
  },

  // ---- conversation thread ----------------------------------------------------------------------
  thread: {
    /** Chronological (oldest first); `before` is a created_at cursor for older pages. */
    async list(botId: string, options: { limit?: number; before?: string } = {}): Promise<BotThreadMessage[]> {
      return (await get<{ messages: BotThreadMessage[] }>(`${bot(botId)}/thread${buildQuery(options)}`)).messages;
    },
    /** Posts as the operator and wakes the bot through an `operator_message` event. */
    async send(botId: string, body: string): Promise<BotThreadMessage> {
      return (await post<{ message: BotThreadMessage }>(`${bot(botId)}/thread`, { body })).message;
    },
  },

  // ---- learning: proposals, reflection, evals, shadow -------------------------------------------
  learning: {
    async proposals(botId: string, status?: string): Promise<BotProposal[]> {
      return (await get<{ proposals: BotProposal[] }>(`${bot(botId)}/proposals${buildQuery({ status })}`)).proposals;
    },
    async approve(botId: string, proposalId: string, editedBody?: string): Promise<BotProposal> {
      const body = editedBody === undefined ? {} : { editedBody };
      return (await post<{ proposal: BotProposal }>(`${bot(botId)}/proposals/${seg(proposalId)}/approve`, body)).proposal;
    },
    async reject(botId: string, proposalId: string): Promise<BotProposal> {
      return (await post<{ proposal: BotProposal }>(`${bot(botId)}/proposals/${seg(proposalId)}/reject`)).proposal;
    },
    /** Runs the reflector now (can take a while: it calls a model). */
    async reflect(botId: string): Promise<BotProposal[]> {
      return (await post<{ proposals: BotProposal[] }>(`${bot(botId)}/reflect`)).proposals;
    },
    async buildEvalSuite(botId: string): Promise<unknown> {
      return (await post<{ suite: unknown }>(`${bot(botId)}/evals/suite`)).suite;
    },
    /** Starts a shadow evaluation job (202); poll `shadowJob` until it is no longer `running`. */
    startShadow: (botId: string, candidate: BotShadowCandidate, episodes?: number): Promise<{ jobId: string; status: BotShadowJob['status'] }> =>
      post(`${bot(botId)}/shadow`, { candidate, ...(episodes === undefined ? {} : { episodes }) }),
    async shadowJob(botId: string, jobId: string): Promise<BotShadowJob> {
      return (await get<{ job: BotShadowJob }>(`${bot(botId)}/shadow/${seg(jobId)}`)).job;
    },
  },

  // ---- skills -----------------------------------------------------------------------------------
  skills: {
    async list(botId: string): Promise<BotSkill[]> {
      return (await get<{ skills: BotSkill[] }>(`${bot(botId)}/skills`)).skills;
    },
    get: (botId: string, name: string): Promise<{ skill: BotSkill; content: string }> => get(`${bot(botId)}/skills/${seg(name)}`),
    async save(botId: string, name: string, input: BotSkillSaveInput): Promise<BotSkill> {
      return (await put<{ skill: BotSkill }>(`${bot(botId)}/skills/${seg(name)}`, input)).skill;
    },
    async fromRun(botId: string, ref: { runId?: string; episodeId?: string }): Promise<BotSkill> {
      return (await post<{ skill: BotSkill }>(`${bot(botId)}/skills/from-run`, ref)).skill;
    },
    async linkCatalog(botId: string, path: string): Promise<BotSkill> {
      return (await post<{ skill: BotSkill }>(`${bot(botId)}/skills/link`, { path })).skill;
    },
    async setEnabled(botId: string, name: string, enabled: boolean): Promise<BotSkill> {
      const action = enabled ? 'enable' : 'disable';
      return (await post<{ skill: BotSkill }>(`${bot(botId)}/skills/${seg(name)}/${action}`)).skill;
    },
    remove: (botId: string, name: string): Promise<{ deleted: boolean }> => del(`${bot(botId)}/skills/${seg(name)}`),
  },

  // ---- operator profile (global) ----------------------------------------------------------------
  profile: {
    async list(): Promise<BotOperatorProfileEntry[]> {
      return (await get<{ entries: BotOperatorProfileEntry[] }>('/operator-profile')).entries;
    },
    async set(key: string, value: string): Promise<BotOperatorProfileEntry> {
      return (await put<{ entry: BotOperatorProfileEntry }>(`/operator-profile/${seg(key)}`, { value })).entry;
    },
    remove: (key: string): Promise<{ deleted: boolean }> => del(`/operator-profile/${seg(key)}`),
  },

  // ---- morning brief ----------------------------------------------------------------------------
  brief: {
    async get(since?: string): Promise<BotBrief> {
      return (await get<{ brief: BotBrief }>(`/brief${buildQuery({ since })}`)).brief;
    },
    /** Delivers the brief on the operator's channels. The exact result shape is owned by channels/brief.service. */
    send: (since?: string): Promise<Record<string, unknown>> => post('/brief/send', since ? { since } : {}),
  },

  // ---- collaboration (teams, spaces, peers) -----------------------------------------------------
  collab: {
    async listTeams(): Promise<BotTeam[]> {
      return (await get<{ teams: BotTeam[] }>('/teams')).teams;
    },
    async getTeam(teamId: string): Promise<BotTeam> {
      return (await get<{ team: BotTeam }>(`/teams/${seg(teamId)}`)).team;
    },
    async createTeam(input: BotTeamInput): Promise<BotTeam> {
      return (await post<{ team: BotTeam }>('/teams', input)).team;
    },
    async updateTeam(teamId: string, update: { name?: string; goal?: string; coordinator_bot_id?: string | null }): Promise<BotTeam> {
      return (await patch<{ team: BotTeam }>(`/teams/${seg(teamId)}`, update)).team;
    },
    deleteTeam: (teamId: string): Promise<{ deleted: boolean }> => del(`/teams/${seg(teamId)}`),
    async addMember(teamId: string, botId: string, role?: string): Promise<BotTeam> {
      return (await post<{ team: BotTeam }>(`/teams/${seg(teamId)}/members`, { bot_id: botId, ...(role ? { role } : {}) })).team;
    },
    async removeMember(teamId: string, botId: string): Promise<BotTeam> {
      return (await del<{ team: BotTeam }>(`/teams/${seg(teamId)}/members/${seg(botId)}`)).team;
    },
    async setCoordinator(teamId: string, botId: string): Promise<BotTeam> {
      return (await put<{ team: BotTeam }>(`/teams/${seg(teamId)}/coordinator`, { bot_id: botId })).team;
    },
    wakeTeam: (teamId: string, note?: string): Promise<{ woken: boolean; team_id: string; coordinator_bot_id: string }> =>
      post(`/teams/${seg(teamId)}/wake`, note ? { note } : {}),
    async spaceRoots(): Promise<unknown[]> {
      return (await get<{ roots: unknown[] }>('/space-roots')).roots;
    },
    async listSpaces(botId: string): Promise<BotSpace[]> {
      return (await get<{ spaces: BotSpace[] }>(`${bot(botId)}/spaces`)).spaces;
    },
    async createSpace(botId: string, input: { title: string; kind?: string; root?: string; content?: string }): Promise<BotSpace> {
      return (await post<{ space: BotSpace }>(`${bot(botId)}/spaces`, input)).space;
    },
    getSpace: (botId: string, spaceId: string): Promise<BotSpaceContent> => get(`${bot(botId)}/spaces/${seg(spaceId)}`),
    async writeSpace(botId: string, spaceId: string, content: string, mode: 'replace' | 'append' = 'replace'): Promise<BotSpace> {
      return (await put<{ space: BotSpace }>(`${bot(botId)}/spaces/${seg(spaceId)}`, { content, mode })).space;
    },
    deleteSpace: (botId: string, spaceId: string): Promise<{ deleted: boolean }> => del(`${bot(botId)}/spaces/${seg(spaceId)}`),
    peers: (botId: string, limit?: number): Promise<BotPeers> => get(`${bot(botId)}/peers${buildQuery({ limit })}`),
  },

  // ---- execution: credentials, teach mode, host (PROVISIONAL until E1 lands) --------------------
  exec: {
    /** Credential names only; values never leave the vault. Tolerates `string[]` or `{ name }[]`. */
    async listCredentials(botId: string): Promise<BotCredentialName[]> {
      const payload = await get<{ credentials?: Array<string | BotCredentialName> }>(`${bot(botId)}/credentials`);
      return (payload.credentials ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : entry));
    },
    setCredential: (botId: string, name: string, value: string): Promise<Record<string, unknown>> =>
      put(`${bot(botId)}/credentials/${seg(name)}`, { value }),
    removeCredential: (botId: string, name: string): Promise<Record<string, unknown>> =>
      del(`${bot(botId)}/credentials/${seg(name)}`),
    startTeach: (botId: string, input: { title?: string } = {}): Promise<BotTeachState> => post(`${bot(botId)}/teach/start`, input),
    stopTeach: (botId: string, input: { name?: string } = {}): Promise<BotTeachState> => post(`${bot(botId)}/teach/stop`, input),
    host: (): Promise<BotRuntimeHost> => get('/runtime/host'),
  },

  // ---- privacy: export + purge ------------------------------------------------------------------
  privacy: {
    /** Redacted JSON export of everything the runtime holds for this bot. */
    exportBot: (botId: string): Promise<Record<string, unknown>> => get(`${bot(botId)}/export`),
    async purge(botId: string, selection: BotPurgeSelection): Promise<BotPurgeCounts> {
      return (await post<{ purged: BotPurgeCounts }>(`${bot(botId)}/purge`, selection)).purged;
    },
  },
};

export type BotRuntimeApi = typeof botRuntimeApi;
