/**
 * Pure helpers for the Guardrails step's "what may this bot do without asking" choices. The server
 * classifier (GET /risk/classify) is the authority on risk; this only decides which tools are worth
 * asking it about and turns the user's choices into bot-scoped rules.
 */

import type { BotRisk, BotRiskPreview, BotRuleInput } from '../types/botRuntime';
import { BOT_SAFETY_FLOOR } from '../types/botRuntime';
import { RISK_DESCRIPTIONS } from '../view/tabs/runtime/rules/ruleHelpers';

import type { AllowChoice } from './runtimeDraft';

const READ_VERBS = new Set(['get', 'list', 'read', 'search', 'fetch', 'query', 'describe', 'find', 'check', 'show', 'view', 'count', 'lookup', 'retrieve', 'snapshot', 'screenshot']);

/**
 * Tools whose first word says they only read; classifying them can never produce a floor risk, so the
 * wizard skips the server round trip. `listIssues`, `list_issues` and `list-issues` all read;
 * `listen_and_send` does not (its first word is "listen").
 */
export function isObviouslyReadTool(tool: string): boolean {
  const first = tool.trim().replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).find(Boolean);
  return first !== undefined && READ_VERBS.has(first.toLowerCase());
}

export const choiceKey = (server: string, tool: string): string => `${server}\u0000${tool}`;

export type ToolRiskItem = { server: string; tool: string; description?: string; risk: BotRisk; floor: boolean };

/** Floor-risk tools (the ones that ask by default), grouped by server in a stable order. */
export function floorItemsByServer(items: ToolRiskItem[]): Array<{ server: string; items: ToolRiskItem[] }> {
  const groups = new Map<string, ToolRiskItem[]>();
  for (const item of items) {
    if (!item.floor) continue;
    groups.set(item.server, [...(groups.get(item.server) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, list]) => ({ server, items: [...list].sort((a, b) => a.tool.localeCompare(b.tool)) }));
}

export function toRiskItem(server: string, tool: { name: string; description?: string }, preview: BotRiskPreview): ToolRiskItem {
  return { server, tool: tool.name, ...(tool.description ? { description: tool.description } : {}), risk: preview.risk, floor: preview.floor };
}

export const isAllowed = (allow: AllowChoice[], server: string, tool: string): boolean =>
  allow.some((choice) => choice.server === server && choice.tool === tool);

export function toggleAllow(allow: AllowChoice[], item: Pick<ToolRiskItem, 'server' | 'tool' | 'risk'>, on: boolean): AllowChoice[] {
  const rest = allow.filter((choice) => !(choice.server === item.server && choice.tool === item.tool));
  return on ? [...rest, { server: item.server, tool: item.tool, risk: item.risk }] : rest;
}

/** Drop choices for servers that are no longer attached (their tools cannot run anyway). */
export const pruneAllow = (allow: AllowChoice[], attachedServers: string[]): AllowChoice[] =>
  allow.filter((choice) => attachedServers.includes(choice.server));

/** Mirrors the server's escapeGlobLiteral: a literal tool or server name used as a glob. */
export const escapeGlobLiteral = (value: string): string => value.replace(/[\\*]/g, '\\$&');

const RISK_ACTION_WORDS: Record<string, string> = {
  send: 'sends a message',
  publish: 'publishes publicly',
  delete: 'deletes data',
  purchase: 'spends money',
  credential: 'touches credentials',
  prod_change: 'changes production',
};

/** "send_message (sends a message)" for a checkbox label. */
export function describeAllowChoice(item: Pick<ToolRiskItem, 'tool' | 'risk'>): string {
  const what = RISK_ACTION_WORDS[item.risk] ?? RISK_DESCRIPTIONS[item.risk]?.replace(/\.$/, '').toLowerCase() ?? item.risk;
  return `${item.tool} (${what})`;
}

export const WIZARD_RULE_NOTE = 'Set in the Bot Architect';

/** A bot-scoped allow for exactly one tool, narrowed to the risk it was classified as. */
export function allowRuleInput(choice: AllowChoice): BotRuleInput {
  return {
    scope: 'bot',
    decision: 'allow',
    match: { server: escapeGlobLiteral(choice.server), tool: escapeGlobLiteral(choice.tool), risk: [choice.risk] },
    note: `${WIZARD_RULE_NOTE}: allow ${choice.tool}`,
  };
}

/** A bot-scoped deny for every tool classified as `risk`; priority keeps it above any allow. */
export function denyRiskRuleInput(risk: 'delete' | 'purchase'): BotRuleInput {
  return {
    scope: 'bot',
    decision: 'deny',
    match: { risk: [risk] },
    priority: 100,
    note: `${WIZARD_RULE_NOTE}: never ${risk === 'delete' ? 'delete anything' : 'purchase anything'}`,
  };
}

export const isFloorRiskName = (risk: string): boolean => (BOT_SAFETY_FLOOR as string[]).includes(risk);
