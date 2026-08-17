import type { LLMProvider } from '../../types/app';
import type { McpFormState, McpTransport } from './types';
import { DEFAULT_MCP_FORM } from './constants';

/**
 * One-click MCP recipes for the catalog. These are local/stdio or public
 * HTTP endpoints — never provider-account connectors (those stay on claude.ai
 * / grok.com).
 */
export type McpTemplate = {
  id: string;
  name: string;
  label: string;
  description: string;
  category: 'local' | 'dev' | 'data' | 'web' | 'remote';
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envHints?: string[];
  /** Suggested agent bindings when applying. */
  defaultProviders?: LLMProvider[];
};

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    label: 'Filesystem',
    description: 'Read/write files under a root path via @modelcontextprotocol/server-filesystem.',
    category: 'local',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    defaultProviders: ['claude', 'grok'],
  },
  {
    id: 'memory',
    name: 'memory',
    label: 'Memory (knowledge graph)',
    description: 'Persistent local knowledge graph for agent memory.',
    category: 'local',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    defaultProviders: ['claude'],
  },
  {
    id: 'github',
    name: 'github',
    label: 'GitHub',
    description: 'Repos, PRs, issues via the official GitHub MCP (needs GITHUB_PERSONAL_ACCESS_TOKEN).',
    category: 'dev',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envHints: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    defaultProviders: ['claude', 'cursor', 'codex'],
  },
  {
    id: 'postgres',
    name: 'postgres',
    label: 'PostgreSQL',
    description: 'Read-only SQL against a Postgres URL (POSTGRES_CONNECTION_STRING).',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envHints: ['POSTGRES_CONNECTION_STRING'],
    defaultProviders: ['claude', 'grok'],
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    label: 'SQLite',
    description: 'Query a local SQLite database file.',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db'],
    defaultProviders: ['claude'],
  },
  {
    id: 'puppeteer',
    name: 'puppeteer',
    label: 'Puppeteer',
    description: 'Browser automation / screenshots for web QA.',
    category: 'web',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    defaultProviders: ['claude'],
  },
  {
    id: 'fetch',
    name: 'fetch',
    label: 'Fetch',
    description: 'HTTP fetch tool for agents (HTML → markdown).',
    category: 'web',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    defaultProviders: ['claude', 'grok', 'cursor'],
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    label: 'Brave Search',
    description: 'Web search via Brave (BRAVE_API_KEY).',
    category: 'web',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envHints: ['BRAVE_API_KEY'],
    defaultProviders: ['claude'],
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured multi-step reasoning scratchpad for hard problems.',
    category: 'local',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    defaultProviders: ['claude', 'grok'],
  },
  {
    id: 'fluxito',
    name: 'fluxito',
    label: 'Fluxito (remote)',
    description: 'Remote analytics / tracking-plan MCP. Paste your Fluxito /mcp URL after auth.',
    category: 'remote',
    transport: 'http',
    url: 'https://your-fluxito-host/mcp',
    defaultProviders: ['claude', 'grok', 'cursor'],
  },
];

export function formStateFromTemplate(template: McpTemplate): McpFormState {
  return {
    ...DEFAULT_MCP_FORM,
    name: template.name,
    transport: template.transport,
    command: template.command ?? '',
    args: template.args ?? [],
    url: template.url ?? '',
    scope: 'user',
    importMode: 'form',
  };
}
