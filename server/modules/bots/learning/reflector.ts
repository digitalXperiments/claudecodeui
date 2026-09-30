/**
 * Reflector: heuristics over the last 14 days of one bot's history that produce deduplicated
 * learning proposals (memory, rule, new skill, skill patch). Runs when an episode finishes, when new
 * human feedback arrives and on a 30 minute sweep. Nothing here applies a change except the opt-in
 * memory auto-promotion in learning.service.
 */
import { isBotsRuntimeV2Enabled } from '@/modules/app-features/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import type { BotEpisode, BotLearningProposal, BotProposalKind } from '@/modules/bots/bots.types.js';
import { BUILTIN_GATE_SERVER, rules, SAFETY_FLOOR } from '@/modules/bots/gate/index.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botProposalsDb } from '@/modules/bots/learning/bot-proposals.repository.js';
import { botSkillsDb } from '@/modules/bots/learning/bot-skills.repository.js';
import { collectFeedback, isHiddenProposal, NEGATIVE_KINDS, POSITIVE_KINDS, type FeedbackEntry } from '@/modules/bots/learning/feedback.js';
import { learning } from '@/modules/bots/learning/learning.service.js';
import { clip, DAY_MS, LEARNING_WINDOW_DAYS, shortHash, SUPPRESS_REJECTED_DAYS } from '@/modules/bots/learning/learning.util.js';
import { draftSkill, episodeItems, executedSteps } from '@/modules/bots/learning/skill-draft.js';

export const SWEEP_INTERVAL_MS = 30 * 60_000;
const MIN_DISMISSALS = 3;
const MIN_RULE_APPROVALS = 5;
const MIN_SKILL_TOOL_CALLS = 3;
const FEATURE_TIERS = ['sender', 'domain', 'source', 'kw'] as const;

export interface ReflectOptions {
  now?: Date;
}

interface ProposalDraft {
  kind: BotProposalKind;
  key: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  evidence: unknown[];
  confidence: number;
}

const evidenceIds = (evidence: unknown[]): string =>
  evidence.filter((e): e is string => typeof e === 'string').sort().join(',');

/**
 * Create a proposal unless an equivalent one was approved, or rejected in the last 30 days. An older
 * pending duplicate with different evidence is superseded; with identical evidence it is kept as is.
 */
function propose(botId: string, draft: ProposalDraft, now: Date): BotLearningProposal | null {
  const existing = botProposalsDb
    .list(botId)
    .filter((p) => !isHiddenProposal(p) && p.payload.dedupe_key === draft.key);
  for (const prior of existing) {
    if (prior.status === 'approved' || prior.status === 'applied') return null;
    if (prior.status === 'rejected' && prior.decided_at && now.getTime() - Date.parse(prior.decided_at) < SUPPRESS_REJECTED_DAYS * DAY_MS) return null;
    if (prior.status === 'proposed' && evidenceIds(prior.evidence) === evidenceIds(draft.evidence) && prior.title === draft.title) return null;
  }
  for (const prior of existing) if (prior.status === 'proposed') learning.supersede(prior.proposal_id);
  const created = botProposalsDb.create({
    botId,
    kind: draft.kind,
    title: clip(draft.title, 200),
    body: draft.body,
    payload: { ...draft.payload, dedupe_key: draft.key },
    evidence: draft.evidence,
    confidence: Math.max(0, Math.min(1, Number(draft.confidence.toFixed(2)))),
  });
  learning.announce(created);
  return learning.maybeAutoPromote(created);
}

// ---- memory: dismissals ---------------------------------------------------------------------

function describeFeature(feature: string): string {
  const [tier, ...rest] = feature.split(':');
  const value = rest.join(':');
  if (tier === 'sender') return `mail from ${value}`;
  if (tier === 'domain') return `senders at ${value}`;
  if (tier === 'source') return `items from the "${value}" source`;
  return `items about "${value}"`;
}

function dismissalProposals(feedback: FeedbackEntry[]): ProposalDraft[] {
  const dismissed = new Map<string, FeedbackEntry>();
  const positive = new Map<string, Set<string>>();
  for (const entry of feedback) {
    if (!entry.item_id) continue;
    if (entry.kind === 'dismiss') dismissed.set(entry.item_id, entry);
    else if (POSITIVE_KINDS.has(entry.kind)) {
      for (const feature of entry.features ?? []) {
        if (!positive.has(feature)) positive.set(feature, new Set());
        positive.get(feature)!.add(entry.item_id);
      }
    }
  }
  const byFeature = new Map<string, Set<string>>();
  for (const [itemId, entry] of dismissed) {
    for (const feature of entry.features ?? []) {
      if (!byFeature.has(feature)) byFeature.set(feature, new Set());
      byFeature.get(feature)!.add(itemId);
    }
  }
  const covered = new Set<string>();
  const drafts: ProposalDraft[] = [];
  for (const tier of FEATURE_TIERS) {
    const candidates = [...byFeature.entries()]
      .filter(([feature, ids]) => feature.startsWith(`${tier}:`) && ids.size >= MIN_DISMISSALS)
      .sort((a, b) => b[1].size - a[1].size);
    for (const [feature, ids] of candidates) {
      if ((positive.get(feature)?.size ?? 0) >= ids.size) continue;
      if ([...ids].every((id) => covered.has(id))) continue;
      ids.forEach((id) => covered.add(id));
      const what = describeFeature(feature);
      const content = `Ignore/deprioritize ${what}: the operator dismissed ${ids.size} such items in the last ${LEARNING_WINDOW_DAYS} days.`;
      drafts.push({
        kind: 'memory',
        key: `dismiss:${feature}`,
        title: `Ignore/deprioritize ${what}`,
        body: content,
        payload: { content, feature, count: ids.size },
        evidence: [...ids],
        confidence: Math.min(0.9, 0.5 + 0.08 * ids.size + (tier === 'sender' ? 0.1 : 0)),
      });
    }
  }
  return drafts;
}

// ---- memory: send-backs ---------------------------------------------------------------------

function sendBackProposals(feedback: FeedbackEntry[]): ProposalDraft[] {
  const drafts: ProposalDraft[] = [];
  for (const entry of feedback) {
    const instruction = entry.kind === 'send_back' ? entry.text?.trim() : '';
    if (!instruction) continue;
    const content = clip(`When handling "${clip(entry.title ?? 'this kind of item', 80)}", ${instruction}`, 1_000);
    drafts.push({
      kind: 'memory',
      key: `sendback:${shortHash(instruction)}`,
      title: clip(content, 120),
      body: content,
      payload: { content, source: 'send_back' },
      evidence: [entry.item_id, entry.episode_id].filter(Boolean),
      confidence: 0.6,
    });
  }
  return drafts;
}

// ---- rule: repeatedly approved tool ---------------------------------------------------------

function ruleProposals(botId: string, sinceMs: number): ProposalDraft[] {
  const stats = new Map<string, { server: string; tool: string; risk: string; approved: string[]; rejected: number }>();
  for (const d of botGateDecisionsDb.listForBot(botId, 5_000)) {
    if (Date.parse(d.created_at) < sinceMs || d.server === BUILTIN_GATE_SERVER) continue;
    const key = `${d.server}\u0000${d.tool}`;
    const stat = stats.get(key) ?? { server: d.server, tool: d.tool, risk: d.risk, approved: [], rejected: 0 };
    const humanApproved = d.decision === 'ask' && (d.outcome === 'approved' || d.outcome === 'executed');
    const rejected = d.outcome === 'rejected' || (d.decision === 'deny' && d.decided_by.startsWith('rule:'));
    if (humanApproved) stat.approved.push(d.decision_id);
    if (rejected) stat.rejected += 1;
    stats.set(key, stat);
  }
  const existing = rules.list({ botId });
  const drafts: ProposalDraft[] = [];
  for (const stat of stats.values()) {
    if (stat.approved.length < MIN_RULE_APPROVALS || stat.rejected > 0) continue;
    if (existing.some((r) => r.match.server === stat.server && r.match.tool === stat.tool)) continue;
    const floor = (SAFETY_FLOOR as string[]).includes(stat.risk);
    drafts.push({
      kind: 'rule',
      key: `rule:${stat.server}/${stat.tool}`,
      title: `Always allow ${stat.server}.${stat.tool}`,
      body: `You approved ${stat.server}.${stat.tool} ${stat.approved.length} times in the last ${LEARNING_WINDOW_DAYS} days and never rejected it.${floor ? ' This is a high-risk action (safety floor): review before approving.' : ''}`,
      payload: { server: stat.server, tool: stat.tool, risk: stat.risk, floor, expires_days: 30, count: stat.approved.length },
      evidence: stat.approved,
      confidence: Math.min(0.95, 0.6 + 0.03 * stat.approved.length),
    });
  }
  return drafts;
}

// ---- new skill: a clean multi-step success --------------------------------------------------

async function newSkillProposals(botId: string, episodes: BotEpisode[], feedback: FeedbackEntry[]): Promise<ProposalDraft[]> {
  const drafts: ProposalDraft[] = [];
  for (const episode of episodes) {
    if (episode.status !== 'succeeded') continue;
    const itemIds = Array.isArray(episode.outcome.item_ids) ? episode.outcome.item_ids.filter((id): id is string => typeof id === 'string') : [];
    if (itemIds.length === 0) continue;
    const mine = feedback.filter((f) => f.episode_id === episode.episode_id && f.item_id);
    const clean = itemIds.every((id) => {
      const entries = mine.filter((f) => f.item_id === id);
      return entries.some((f) => POSITIVE_KINDS.has(f.kind)) && !entries.some((f) => NEGATIVE_KINDS.has(f.kind));
    });
    if (!clean) continue;
    const { steps, decisions } = executedSteps(botId, { episodeId: episode.episode_id });
    if (steps.length < MIN_SKILL_TOOL_CALLS) continue;
    // Drafting may call a model: never redo it for an episode that already has a proposal.
    if (botProposalsDb.list(botId).some((p) => p.payload.dedupe_key === `skill:${episode.episode_id}`)) continue;
    const draft = await draftSkill({ botId, episode, steps, items: episodeItems(botId, episode.episode_id) });
    if (botSkillsDb.getByName(botId, draft.name)) continue;
    drafts.push({
      kind: 'new_skill',
      key: `skill:${episode.episode_id}`,
      title: `Save as skill: ${draft.name}`,
      body: draft.content,
      payload: { name: draft.name, description: draft.description, content: draft.content, episode_id: episode.episode_id },
      evidence: [episode.episode_id, ...itemIds, ...decisions.map((d) => d.decision_id)],
      confidence: Math.min(0.9, 0.55 + 0.05 * steps.length),
    });
  }
  return drafts;
}

// ---- skill patch: a used skill drew negative feedback ---------------------------------------

function skillPatchProposals(botId: string, episodes: BotEpisode[], feedback: FeedbackEntry[]): ProposalDraft[] {
  const owned = botSkillsDb.list(botId).filter((skill) => skill.origin !== 'catalog');
  const drafts: ProposalDraft[] = [];
  for (const episode of episodes) {
    const plan = episode.plan_text.toLowerCase();
    const used = owned.filter((skill) => plan.includes(skill.name.toLowerCase()) || plan.includes(skill.name.replace(/-/g, ' ').toLowerCase()));
    if (used.length === 0) continue;
    const negatives = feedback.filter((f) => f.episode_id === episode.episode_id && (f.kind === 'send_back' || f.kind === 'deny'));
    for (const entry of negatives) {
      for (const skill of used) {
        const what = entry.kind === 'send_back' ? 'Sent back' : 'Denied';
        const note = clip(`${entry.at.slice(0, 10)}: ${what} "${entry.title ?? 'an item'}"${entry.text ? `: ${entry.text}` : ''}. Adjust this skill accordingly.`, 600);
        drafts.push({
          kind: 'skill_patch',
          key: `patch:${skill.name}:${shortHash(`${entry.kind}${entry.text ?? entry.title ?? ''}`)}`,
          title: `Add a lesson to skill ${skill.name}`,
          body: note,
          payload: { skill: skill.name, note },
          evidence: [episode.episode_id, entry.item_id].filter(Boolean),
          confidence: entry.text ? 0.65 : 0.55,
        });
      }
    }
  }
  return drafts;
}

// ---- orchestration --------------------------------------------------------------------------

async function runReflection(botId: string, options: ReflectOptions): Promise<BotLearningProposal[]> {
  if (!missionControlDb.getSection(botId)) return [];
  const now = options.now ?? new Date();
  const since = now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS;
  const human = collectFeedback(botId, since).filter((entry) => entry.actor === 'human');
  const episodes = botEpisodesDb.list(botId, 200).filter((e) => Date.parse(e.started_at) >= since);

  const drafts: ProposalDraft[] = [
    ...dismissalProposals(human),
    ...sendBackProposals(human),
    ...ruleProposals(botId, since),
    ...(await newSkillProposals(botId, episodes, human)),
    ...skillPatchProposals(botId, episodes, human),
  ];
  const created: BotLearningProposal[] = [];
  for (const draft of drafts) {
    const proposal = propose(botId, draft, now);
    if (proposal) created.push(proposal);
  }
  return created;
}

const queues = new Map<string, Promise<unknown>>();

/** Reflect on one bot. Serialized per bot so overlapping triggers never double-create. */
export function reflectBot(botId: string, options: ReflectOptions = {}): Promise<BotLearningProposal[]> {
  const run = (queues.get(botId) ?? Promise.resolve()).catch(() => undefined).then(() => runReflection(botId, options));
  queues.set(botId, run);
  void run.catch(() => undefined).finally(() => {
    if (queues.get(botId) === run) queues.delete(botId);
  });
  return run;
}

export const reflector = {
  reflectBot,

  /** Proposals created as a result of this episode finishing (heuristics run over the whole window). */
  async onEpisodeFinished(episodeId: string): Promise<BotLearningProposal[]> {
    const episode = botEpisodesDb.get(episodeId);
    if (!episode) return [];
    return reflectBot(episode.bot_id);
  },

  async sweep(options: ReflectOptions = {}): Promise<BotLearningProposal[]> {
    if (!isBotsRuntimeV2Enabled()) return [];
    const created: BotLearningProposal[] = [];
    for (const section of missionControlDb.listSections()) {
      try {
        created.push(...(await reflectBot(section.section_id, options)));
      } catch (error) {
        console.warn('[bots] reflector sweep failed', { botId: section.section_id, error: error instanceof Error ? error.message : error });
      }
    }
    return created;
  },
};
