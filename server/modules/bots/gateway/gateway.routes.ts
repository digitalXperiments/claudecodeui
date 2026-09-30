import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { appConfigDb } from '@/modules/database/index.js';
import { mcpCatalogService } from '@/modules/providers/index.js';

import { callGatewayTool, listGatewayToolsForSession } from './gateway.service.js';

export const BOT_GATEWAY_MCP_SERVER_NAME = 'cloudcli-tool-gateway';
const MCP_TOKEN_CONFIG_KEY = 'bot_gateway_mcp_token';
/** Providers the gateway entry is projected to (Antigravity has no MCP facet to project into). */
const GATEWAY_PROVIDERS = ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi', 'omp'] as const;

export function getBotGatewayMcpToken(): string {
  const existing = appConfigDb.get(MCP_TOKEN_CONFIG_KEY)?.trim();
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(MCP_TOKEN_CONFIG_KEY, token);
  return token;
}

function getApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/bot-gateway-mcp`;
}

function getMcpCommand(): { command: string; args: string[] } {
  // Compiled layout: <root>/server/bot-tool-gateway-mcp.js; source layout: <root>/server/bot-tool-gateway-mcp.ts.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const compiled = path.join(dir, 'bot-tool-gateway-mcp.js');
    if (fs.existsSync(compiled)) return { command: process.execPath, args: [compiled] };
    const source = path.join(dir, 'bot-tool-gateway-mcp.ts');
    const tsxCli = path.join(dir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(source) && fs.existsSync(tsxCli)) {
      return { command: process.execPath, args: [tsxCli, '--tsconfig', path.join(dir, 'tsconfig.json'), source] };
    }
    dir = path.dirname(dir);
  }
  return { command: 'cloudcli', args: ['bot-tool-gateway-mcp'] };
}

/** Upserts the `cloudcli-tool-gateway` catalog entry (stdio proxy) and projects it to providers. */
export async function registerBotGatewayMcp(): Promise<{ name: string }> {
  const { command, args } = getMcpCommand();
  await mcpCatalogService.upsert({
    name: BOT_GATEWAY_MCP_SERVER_NAME,
    scope: 'user',
    transport: 'stdio',
    command,
    args,
    env: {
      CLOUDCLI_BOT_GATEWAY_API_URL: getApiUrl(),
      CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: getBotGatewayMcpToken(),
    },
    // Codex only forwards named parent variables to MCP children; providers that
    // inherit the whole environment get these for free.
    envVars: ['CLOUDCLI_SESSION_ID', 'CLOUDCLI_LEAD_SESSION_ID'],
    providers: [...GATEWAY_PROVIDERS],
  });
  return { name: BOT_GATEWAY_MCP_SERVER_NAME };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenMatches(presented: string, expected: string): boolean {
  return presented.length > 0 && timingSafeEqual(digest(presented), digest(expected));
}

function readBearerToken(header: unknown): string {
  if (typeof header !== 'string') return '';
  return /^Bearer\s+(\S.*)$/i.exec(header.trim())?.[1]?.trim() ?? '';
}

const router = express.Router();

router.use((req, res, next) => {
  if (!tokenMatches(readBearerToken(req.headers.authorization), getBotGatewayMcpToken())) {
    res.status(401).json({ success: false, error: 'Invalid Bot Gateway MCP token.' });
    return;
  }
  next();
});

/** Caller identity comes from the stdio child's env (never the body), so a session cannot speak for another. */
function readCallerSessionId(req: express.Request): string {
  return String(req.headers['x-bot-gateway-session-id'] || '').trim();
}

router.post('/tools/list', async (req, res) => {
  try {
    const sessionId = readCallerSessionId(req);
    const tools = sessionId ? await listGatewayToolsForSession(sessionId) : [];
    res.json({ success: true, data: { tools } });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Tool listing failed.' });
  }
});

router.post('/tools/call', async (req, res) => {
  try {
    const sessionId = readCallerSessionId(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) {
      res.status(400).json({ success: false, error: 'name is required.' });
      return;
    }
    const result = await callGatewayTool(sessionId, name, body.arguments);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Tool call failed.' });
  }
});

export default router;
