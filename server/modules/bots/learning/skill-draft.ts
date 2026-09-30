/**
 * Builds SKILL.md drafts from a succeeded episode: plan text, the ordered gated tool calls and the
 * shape of the items the operator accepted. The default drafter is template-only; when the bot has a
 * `reflect` route it asks that model (no tools) to polish the template. `setSkillDrafter` replaces it.
 */
import {
  missionControlDb,
  runMissionControlAgent,
  type McItem,
} from '@/modules/mission-control/index.js';
import { readBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import type { BotEpisode, BotGateDecision } from '@/modules/bots/bots.types.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { clip, slugify } from '@/modules/bots/learning/learning.util.js';

export interface SkillStep {
  server: string;
  tool: string;
  risk: string;
  argKeys: string[];
  decisionId: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  /** Complete SKILL.md text including frontmatter. */
  content: string;
}

export interface SkillDraftInput {
  botId: string;
  episode: BotEpisode;
  steps: SkillStep[];
  items: McItem[];
  template: SkillDraft;
}

export type SkillDrafter = (input: SkillDraftInput) => Promise<SkillDraft | string> | SkillDraft | string;

let customDrafter: SkillDrafter | null = null;

export function setSkillDrafter(drafter: SkillDrafter | null): void {
  customDrafter = drafter;
}

/** Executed tool calls of an episode (or run), oldest first. */
export function executedSteps(botId: string, match: { episodeId?: string; runId?: string }): { steps: SkillStep[]; decisions: BotGateDecision[] } {
  const decisions = botGateDecisionsDb
    .listForBot(botId, 5_000)
    .filter((d) => (match.episodeId ? d.episode_id === match.episodeId : match.runId ? d.run_id === match.runId : false))
    .filter((d) => d.outcome === 'executed')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    decisions,
    steps: decisions.map((d) => ({ server: d.server, tool: d.tool, risk: d.risk, argKeys: Object.keys(d.args).slice(0, 8), decisionId: d.decision_id })),
  };
}

export function episodeItems(botId: string, episodeId: string): McItem[] {
  return missionControlDb.listItems({ sectionId: botId, limit: 500 }).filter((item) => item.source.episodeId === episodeId);
}

export function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, ' ').trim()}\n---\n`;
}

/** Make `content` a valid SKILL.md for `name`: keep an existing frontmatter (forcing the name), else add one. */
export function ensureFrontmatter(content: string, name: string, description: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return `${frontmatter(name, description)}\n${content.replace(/^\s+/, '')}`;
  const lines = match[1].split(/\r?\n/).filter((line) => !/^name\s*:/i.test(line));
  if (!lines.some((line) => /^description\s*:/i.test(line))) lines.push(`description: ${description.replace(/\s+/g, ' ').trim()}`);
  return `---\nname: ${name}\n${lines.join('\n')}\n---\n${content.slice(match[0].length)}`;
}

export function readDescription(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const line = match?.[1].split(/\r?\n/).find((l) => /^description\s*:/i.test(l));
  return line ? line.replace(/^description\s*:\s*/i, '').trim() : '';
}

export function buildTemplateDraft(input: Omit<SkillDraftInput, 'template'>): SkillDraft {
  const { episode, steps, items } = input;
  const subject = episode.summary.trim() || episode.plan_text.split('\n')[0]?.trim() || 'repeatable workflow';
  const name = slugify(subject);
  const description = clip(`Repeat the workflow: ${subject}`, 200);

  const shapeKeys = [...new Set(items.flatMap((item) => Object.keys(item.body)))].slice(0, 12);
  const lines = [
    `# ${clip(subject, 80)}`,
    '',
    '## When to use',
    clip(episode.plan_text.trim() || subject, 1_200),
    '',
    '## Steps',
    ...(steps.length
      ? steps.map((step, index) => `${index + 1}. Call \`${step.server}.${step.tool}\` (${step.risk})${step.argKeys.length ? ` with ${step.argKeys.join(', ')}` : ''}.`)
      : ['1. Follow the plan above.']),
    '',
    '## Output',
    items.length
      ? `Produce items like: ${items.slice(0, 3).map((item) => `"${clip(item.title, 80)}"`).join(', ')}.`
      : 'Produce the same kind of items as the original run.',
    ...(shapeKeys.length ? [`Each item body includes: ${shapeKeys.join(', ')}.`] : []),
    '',
    '## Approval boundaries',
    'Anything that sends, publishes, deletes or spends still needs the operator\'s approval through the action gate.',
    '',
    '## Lessons',
    '',
  ];
  return { name, description, content: `${frontmatter(name, description)}\n${lines.join('\n')}` };
}

function stripFences(text: string): string {
  const fenced = /```(?:markdown|md)?\r?\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

async function polish(input: SkillDraftInput): Promise<SkillDraft> {
  const route = readBotRuntimeConfig(input.botId)?.routing?.reflect;
  const section = missionControlDb.getSection(input.botId);
  if (!route || !section) return input.template;
  try {
    const result = await runMissionControlAgent({
      section: { ...section, provider: route.provider as typeof section.provider, model: route.model ?? null, effort: route.effort ?? null, dry_run: true },
      prompt: [
        'Polish this SKILL.md draft so another agent can follow it. Keep the frontmatter (name, description), keep the section headings,',
        'fix wording, and do not invent tools or steps that are not listed. Reply with the complete SKILL.md only. Do not call any tools.',
        '',
        input.template.content,
      ].join('\n'),
      tools: [],
      sourceRef: input.episode.episode_id,
      trigger: 'reflect',
    });
    const text = stripFences(result.text);
    if (!result.success || !text.startsWith('---')) return input.template;
    return { ...input.template, content: ensureFrontmatter(text, input.template.name, input.template.description) };
  } catch {
    return input.template;
  }
}

export async function draftSkill(input: Omit<SkillDraftInput, 'template'>): Promise<SkillDraft> {
  const template = buildTemplateDraft(input);
  const full: SkillDraftInput = { ...input, template };
  const produced = await (customDrafter ? customDrafter(full) : polish(full));
  if (typeof produced === 'string') return { ...template, content: ensureFrontmatter(produced, template.name, template.description) };
  const name = slugify(produced.name || template.name);
  return { name, description: produced.description || template.description, content: ensureFrontmatter(produced.content, name, produced.description || template.description) };
}
