/**
 * One read-only summary of what a bot can do, for the per-bot "Abilities" UI: autonomy, how firmly
 * it is governed, the apps it can reach, what it may do alone / must ask about / never does (in
 * plain sentences), and its skills, spaces, credentials and browser profile.
 */
import { missionControlDb } from '@/modules/mission-control/index.js';
import type { McSection } from '@/modules/mission-control/index.js';
import { mcpCatalogService } from '@/modules/providers/index.js';

import { AUTONOMY_LABELS, AUTONOMY_SUMMARIES } from '../autonomy.js';
import { readBotRuntimeConfig, resolveBotAutonomy, type BotAutonomy } from '../bots-runtime-config.js';
import type { BotRule, BotRuleMatch } from '../bots.types.js';
import { botSpacesDb } from '../collab/bot-spaces.repository.js';
import { botRulesDb } from '../gate/bot-rules.repository.js';
import { enforcementForAutonomy, type EnforcementLevel } from '../gateway/enforcement.js';
import { skills } from '../learning/skills.service.js';

import { botCredentials } from './bot-credentials.js';
import { browserProfileStatus, type BrowserProfileStatus } from './browser-signin.js';

export interface AbilityApp {
  server: string;
  connected: boolean;
  /** 'catalog' = a CloudCLI MCP catalog entry; 'provider' = a provider-hosted connector (claude.ai ...); 'missing' = unknown. */
  source: 'catalog' | 'provider' | 'missing';
  /** Which parts of the bot use it. */
  phases: Array<'propose' | 'resolve' | 'work'>;
  tools_policy_counts: { allow: number; ask: number; deny: number };
  note?: string;
}

export interface PlainAbilities {
  canDoAlone: string[];
  asksFirst: string[];
  neverDoes: string[];
}

export interface AbilitiesSummary {
  autonomy: BotAutonomy;
  autonomy_label: string;
  autonomy_summary: string;
  provider: string;
  enforcement: { level: EnforcementLevel; detail: string };
  apps: AbilityApp[];
  plain: PlainAbilities;
  skills_count: number;
  spaces_count: number;
  credentials: Array<{ server: string; key: string }>;
  browser: Pick<BrowserProfileStatus, 'profile_exists' | 'size_bytes' | 'last_used_at' | 'in_use' | 'in_use_by' | 'sign_in'> & {
    /** Not available: the profile's cookie store is never read. */
    signed_in_sites?: string[];
  };
}

const PROVIDER_CONNECTOR = /^claude\.ai /i;
const MAX_LISTED = 6;

/** "a, b and c"; long lists are cut with "and N more". */
/** Human name for an attached app: "mcp__obsidian" / "claude.ai Gmail" / "gmail__*" → "Obsidian" / "Gmail". */
export function friendlyAppName(server: string): string {
  const base = server.trim().replace(/^claude\.ai\s+/i, '').replace(/^mcp__/i, '').replace(/__\*?$/, '').replace(/__.*$/, '');
  const words = base.replace(/[-_]+/g, ' ').trim();
  if (!words) return server;
  return words === words.toLowerCase() ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : words;
}

function listNames(names: string[], max = 4): string {
  names = [...new Set(names.map(friendlyAppName))];
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function describeMatch(match: BotRuleMatch): string {
  if (match.server && match.tool) return `${match.tool} in ${match.server}`;
  if (match.server) return `anything in ${match.server}`;
  if (match.tool) return match.tool;
  if (match.risk?.length) return `${match.risk.join(' / ')} actions`;
  return 'matching tools';
}

/** Section tool policy, as the gate sees it: implicit bot-scoped rules. */
function policyRules(section: Pick<McSection, 'tool_policy' | 'section_id'>): BotRule[] {
  const out: BotRule[] = [];
  for (const [server, tools] of Object.entries(section.tool_policy ?? {})) {
    for (const [tool, decision] of Object.entries(tools)) {
      out.push({
        rule_id: `policy:${server}:${tool}`,
        scope: 'bot',
        bot_id: section.section_id,
        match: { server, tool },
        decision,
        priority: 0,
        created_from: 'section_policy',
        note: '',
        expires_at: null,
        created_at: '',
        updated_at: '',
      });
    }
  }
  return out;
}

const cap = (sentences: string[]): string[] =>
  sentences.length <= MAX_LISTED ? sentences : [...sentences.slice(0, MAX_LISTED), `...and ${sentences.length - MAX_LISTED} more rules`];

/** Human sentences for what the bot does alone, asks about, and never does. Pure; exported for tests. */
export function buildPlainAbilities(input: {
  autonomy: BotAutonomy;
  rules: BotRule[];
  dryRun: boolean;
  apps: string[];
}): PlainAbilities {
  const { autonomy, rules, dryRun, apps } = input;
  const allow = rules.filter((rule) => rule.decision === 'allow').map((rule) => `Use ${describeMatch(rule.match)} without asking`);
  const ask = rules.filter((rule) => rule.decision === 'ask').map((rule) => `Check with you before using ${describeMatch(rule.match)}`);
  const deny = rules.filter((rule) => rule.decision === 'deny').map((rule) => `Use ${describeMatch(rule.match)}`);

  if (autonomy === 'unrestricted') {
    // The gate is off: only the provider's permission mode and the section's tool policy apply.
    const policyDeny = rules
      .filter((rule) => rule.created_from === 'section_policy' && rule.decision === 'deny')
      .map((rule) => `Use ${describeMatch(rule.match)} (blocked by its tool policy)`);
    return {
      canDoAlone: [
        "Use any tool its provider allows, without asking you",
        'Send, publish, delete, spend money and change live systems, with nothing held for approval',
        'Read and change files and run commands wherever its provider lets it',
      ],
      asksFirst: [],
      neverDoes: cap(policyDeny),
    };
  }

  const canDoAlone = [
    apps.length > 0 ? `Read and search in its connected apps (${listNames(apps)})` : 'Read, search and summarise what it can reach in its workspace',
    'Write drafts and notes in its own workspace and spaces',
    ...cap(allow),
  ];
  const asksFirst: string[] = [];
  if (autonomy === 'trusted') {
    canDoAlone.push('Send, publish, delete, spend money and change live systems without asking, as long as it has not just read untrusted content');
    canDoAlone.push('Read or run things outside its workspace when it has not just read untrusted content');
    asksFirst.push('Anything involving passwords, API keys or signing in');
    asksFirst.push('Any send, publish, delete, purchase or change once it has read untrusted content (an outside email or web page), until you approve');
  } else {
    asksFirst.push(
      'Send emails or messages',
      'Publish anything publicly',
      'Delete or remove things',
      'Spend money or make purchases',
      'Change live (production) systems',
      'Touch files outside its workspace, or run commands it cannot prove stay local',
      'Anything involving passwords, API keys or signing in',
    );
  }
  asksFirst.push(...cap(ask));
  const neverDoes = [
    "Read CloudCLI's own database, provider logins, keychain or secret files",
    'Dump environment variables',
    "Call CloudCLI's own API or start new tool servers",
    ...cap(deny),
  ];
  if (dryRun) neverDoes.unshift('Take real actions: dry run is on, so it only reads and drafts');
  return { canDoAlone, asksFirst, neverDoes };
}

async function catalogHas(server: string): Promise<boolean> {
  try {
    return Boolean(await mcpCatalogService.getRaw(server));
  } catch {
    return false;
  }
}

async function buildApps(section: McSection, autonomy: BotAutonomy): Promise<AbilityApp[]> {
  const phaseServers: Array<[AbilityApp['phases'][number], string[]]> = [
    ['propose', section.produce_tools ?? []],
    ['resolve', section.resolve_tools ?? []],
    ['work', section.work_profile?.mcp_servers ?? []],
  ];
  const byServer = new Map<string, AbilityApp['phases']>();
  for (const [phase, servers] of phaseServers) {
    for (const server of servers) {
      const phases = byServer.get(server) ?? [];
      if (!phases.includes(phase)) phases.push(phase);
      byServer.set(server, phases);
    }
  }
  const apps: AbilityApp[] = [];
  for (const [server, phases] of byServer) {
    const counts = { allow: 0, ask: 0, deny: 0 };
    for (const decision of Object.values(section.tool_policy?.[server] ?? {})) counts[decision] += 1;
    const inCatalog = await catalogHas(server);
    if (inCatalog) {
      apps.push({ server, connected: true, source: 'catalog', phases, tools_policy_counts: counts });
    } else if (PROVIDER_CONNECTOR.test(server)) {
      // Provider-hosted connectors cannot be proxied by the tool gateway: only an Unrestricted bot reaches them.
      const reachable = autonomy === 'unrestricted';
      apps.push({
        server,
        connected: reachable,
        source: 'provider',
        phases,
        tools_policy_counts: counts,
        ...(reachable ? {} : { note: 'A provider-hosted connector: only reachable when autonomy is Unrestricted (the tool gateway cannot proxy it).' }),
      });
    } else {
      apps.push({ server, connected: false, source: 'missing', phases, tools_policy_counts: counts, note: 'Not found in the CloudCLI MCP catalog.' });
    }
  }
  return apps;
}

export async function buildAbilitiesSummary(botId: string): Promise<AbilitiesSummary | null> {
  const section = missionControlDb.getSection(botId);
  if (!section) return null;
  const runtime = readBotRuntimeConfig(botId);
  const autonomy = resolveBotAutonomy(runtime);
  const provider = runtime?.routing?.act?.provider ?? section.provider;
  const enforcement = enforcementForAutonomy(provider, autonomy, { permissionMode: section.permission_mode });
  const apps = await buildApps(section, autonomy);
  const rules = [...botRulesDb.listApplicable(botId), ...policyRules(section)];
  const browser = await browserProfileStatus(botId);
  return {
    autonomy,
    autonomy_label: AUTONOMY_LABELS[autonomy],
    autonomy_summary: AUTONOMY_SUMMARIES[autonomy],
    provider,
    enforcement: { level: enforcement.level, detail: enforcement.detail },
    apps,
    plain: buildPlainAbilities({ autonomy, rules, dryRun: Boolean(section.dry_run), apps: apps.map((app) => app.server) }),
    skills_count: skills.list(botId).filter((skill) => skill.enabled).length,
    spaces_count: botSpacesDb.list(botId).length,
    credentials: botCredentials.list(botId).map(({ server, key }) => ({ server, key })),
    browser: {
      profile_exists: browser.profile_exists,
      size_bytes: browser.size_bytes,
      last_used_at: browser.last_used_at,
      in_use: browser.in_use,
      in_use_by: browser.in_use_by,
      sign_in: browser.sign_in,
    },
  };
}
