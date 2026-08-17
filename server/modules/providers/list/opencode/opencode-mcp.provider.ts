import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

type OpenCodeConfigPath = {
  filePath: string;
  exists: boolean;
};

export type OpenCodeMcpProviderOptions = {
  provider?: 'opencode' | 'kilo';
  configDirectory?: string;
  configFileName?: string;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Removes JSONC comments without touching comment-like text inside strings.
 */
const stripJsonComments = (content: string): string => {
  let output = '';
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
};

const stripTrailingCommas = (content: string): string =>
  content.replace(/,\s*([}\]])/g, '$1');

const readOpenCodeConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

const writeOpenCodeConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  // OpenCode accepts JSONC on read, but writing comments back into a config
  // file makes downstream tooling that expects JSON (including CloudCLI's
  // inventory and common editors) fail. Normalize the file after a managed
  // update while preserving all non-MCP keys.
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const resolveOpenCodeConfigPath = async (
  scope: McpScope,
  workspacePath: string,
  configDirectory: string,
  configFileName: string,
): Promise<OpenCodeConfigPath> => {
  const root = scope === 'user'
    ? configDirectory
    : workspacePath;
  const jsonPath = path.join(root, `${configFileName}.json`);
  const jsoncPath = path.join(root, `${configFileName}.jsonc`);

  if (await fileExists(jsonPath)) {
    return { filePath: jsonPath, exists: true };
  }

  if (await fileExists(jsoncPath)) {
    return { filePath: jsoncPath, exists: true };
  }

  return { filePath: jsonPath, exists: false };
};

export class OpenCodeMcpProvider extends McpProvider {
  private readonly configuredConfigDirectory?: string;
  private readonly configFileName: string;

  constructor(options: OpenCodeMcpProviderOptions = {}) {
    super(options.provider ?? 'opencode', ['user', 'project'], ['stdio', 'http']);
    this.configuredConfigDirectory = options.configDirectory;
    this.configFileName = options.configFileName ?? 'opencode';
  }

  private getConfigDirectory(): string {
    return this.configuredConfigDirectory ?? path.join(os.homedir(), '.config', 'opencode');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const { filePath } = await resolveOpenCodeConfigPath(
      scope,
      workspacePath,
      this.getConfigDirectory(),
      this.configFileName,
    );
    const config = await readOpenCodeConfig(filePath);
    return readObjectRecord(config.mcp) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const { filePath } = await resolveOpenCodeConfigPath(
      scope,
      workspacePath,
      this.getConfigDirectory(),
      this.configFileName,
    );
    const config = await readOpenCodeConfig(filePath);
    config.mcp = servers;
    await writeOpenCodeConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        enabled: true,
        environment: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: 'remote',
      url: input.url,
      enabled: true,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (config.type === 'local' || config.command !== undefined) {
      const commandParts = typeof config.command === 'string'
        ? [config.command, ...(readStringArray(config.args) ?? [])]
        : readStringArray(config.command);
      const command = commandParts?.[0];
      if (!command) {
        return null;
      }

      return {
        provider: this.provider,
        name,
        scope,
        transport: 'stdio',
        command,
        args: commandParts.slice(1),
        env: readStringRecord(config.environment) ?? readStringRecord(config.env),
      };
    }

    if (config.type === 'remote' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) {
        return null;
      }

      return {
        provider: this.provider,
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
