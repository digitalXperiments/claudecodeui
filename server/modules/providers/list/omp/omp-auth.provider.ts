import { readFile } from 'node:fs/promises';

import Database from 'better-sqlite3';
import spawn from 'cross-spawn';

import { ompAuthPath, ompCredentialDbPath } from '@/modules/providers/list/omp/omp-paths.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

// Env vars Oh My Pi recognizes for API-key auth (subset of the full catalog — enough
// for "is anything configured?" without claiming a specific provider).
const OMP_API_KEY_ENVS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'OPENCODE_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'XIAOMI_API_KEY',
];

export class OmpProviderAuth implements IProviderAuth {
  constructor(private readonly dependencies: {
    checkInstalled?: () => boolean;
    env?: NodeJS.ProcessEnv;
    authPath?: string;
    credentialDbPath?: string;
  } = {}) {}

  private checkInstalled(): boolean {
    if (this.dependencies.checkInstalled) {
      return this.dependencies.checkInstalled();
    }
    try {
      const result = spawn.sync('omp', ['--version'], { stdio: 'ignore', timeout: 5000 });
      // ENOENT (not on PATH) surfaces as result.error; any other status means
      // the binary ran (even if it printed help and exited non-zero).
      return !result.error;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        provider: 'omp',
        authenticated: false,
        email: null,
        method: null,
        error: 'Oh My Pi CLI is not installed. Install with: curl -fsSL https://omp.sh/install | sh',
      };
    }

    const credentials = await this.checkCredentials();
    return {
      installed: true,
      provider: 'omp',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Oh My Pi v18 stores credentials in the active profile's `agent.db`.
   * Environment variables and the legacy `auth.json` remain compatible paths.
   */
  private async checkCredentials(): Promise<{
    authenticated: boolean;
    email: string | null;
    method: string | null;
    error?: string;
  }> {
    const env = this.dependencies.env ?? process.env;
    const envProvider = OMP_API_KEY_ENVS.find((key) => {
      const value = env[key];
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (envProvider) {
      return {
        authenticated: true,
        email: envProvider.replace(/_API_KEY$|_TOKEN$/, ''),
        method: 'api_key_env',
      };
    }

    const databaseProbe = probeOmpCredentialDatabase(
      this.dependencies.credentialDbPath ?? ompCredentialDbPath(),
    );
    if (databaseProbe === 'active') {
      return {
        authenticated: true,
        email: null,
        method: 'credential_store',
      };
    }

    try {
      const content = await readFile(this.dependencies.authPath ?? ompAuthPath(), 'utf8');
      const parsed = readObjectRecord(JSON.parse(content)) ?? {};
      const keys = Object.keys(parsed).filter((key) => {
        const entry = parsed[key];
        if (entry == null) return false;
        if (typeof entry === 'string') return entry.trim().length > 0;
        if (typeof entry === 'object') return Object.keys(entry as object).length > 0;
        return Boolean(entry);
      });

      if (keys.length === 0) {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Not logged in — run `omp` and use /login, or set an API key env var',
        };
      }

      return {
        authenticated: true,
        email: null,
        method: 'auth_file',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof SyntaxError
            ? 'Legacy Oh My Pi auth file is malformed'
            : 'Unable to read legacy Oh My Pi auth file',
        };
      }

      const databaseError = databaseProbe === 'locked'
        ? 'Oh My Pi credential store is locked'
        : databaseProbe === 'malformed'
          ? 'Oh My Pi credential store is malformed'
          : databaseProbe === 'disabled'
            ? 'Oh My Pi has credentials, but all are disabled'
            : undefined;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: databaseError || 'Not logged in — run `omp` and use /login, or set an API key env var',
      };
    }
  }
}

export type OmpCredentialProbe = 'active' | 'disabled' | 'absent' | 'locked' | 'malformed';

/**
 * Read only two boolean markers from OMP's SQLite store. Neither query selects
 * provider ids, credential blobs, tokens, or any other credential data.
 */
export function probeOmpCredentialDatabase(databasePath: string): OmpCredentialProbe {
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 25,
    });
    const active = database.prepare(`
      SELECT 1 AS marker
      FROM auth_credentials
      WHERE disabled_cause IS NULL OR TRIM(disabled_cause) = ''
      LIMIT 1
    `).get();
    if (active) {
      return 'active';
    }

    const any = database.prepare('SELECT 1 AS marker FROM auth_credentials LIMIT 1').get();
    return any ? 'disabled' : 'absent';
  } catch (error) {
    const code = (error as { code?: string }).code || '';
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (code === 'SQLITE_CANTOPEN' || message.includes('does not exist')) {
      return 'absent';
    }
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || message.includes('locked')) {
      return 'locked';
    }
    return 'malformed';
  } finally {
    database?.close();
  }
}
