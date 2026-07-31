import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class CodexProviderAuth implements IProviderAuth {
  /**
   * Checks whether Codex is available to the server runtime.
   */
  private checkInstalled(): boolean {
    try {
      spawn.sync('codex', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Codex SDK availability and credential status.
   *
   * Prefer `codex login status` (what the CLI itself reports) over parsing
   * auth.json so CloudCLI stays in sync with shell/chat runs.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        provider: 'codex',
        authenticated: false,
        email: null,
        method: null,
        error: 'Codex CLI is not installed',
      };
    }

    const fromCli = await this.checkCliLoginStatus();
    if (fromCli) {
      return {
        installed,
        provider: 'codex',
        authenticated: fromCli.authenticated,
        email: fromCli.email,
        method: fromCli.method,
        error: fromCli.authenticated ? undefined : fromCli.error || 'Not authenticated',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Parses `codex login status` output (e.g. "Logged in using ChatGPT").
   */
  private checkCliLoginStatus(): Promise<CodexCredentialsStatus | null> {
    return new Promise((resolve) => {
      let done = false;
      let child: ReturnType<typeof spawn> | undefined;
      const finish = (value: CodexCredentialsStatus | null) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        child?.kill();
        finish(null);
      }, 5000);

      try {
        child = spawn('codex', ['login', 'status'], {
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
      } catch {
        finish(null);
        return;
      }

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        const text = `${stdout}\n${stderr}`;
        if (/logged in/i.test(text)) {
          const methodMatch = text.match(/Logged in using\s+(.+)/i);
          finish({
            authenticated: true,
            email: methodMatch?.[1]?.trim() || 'Authenticated',
            method: 'cli',
          });
          return;
        }
        if (code === 0) {
          finish({ authenticated: false, email: null, method: null, error: 'Not logged in' });
          return;
        }
        // Non-zero without a clear message → fall back to auth.json.
        finish(null);
      });
    });
  }

  /**
   * Reads Codex auth.json and checks OAuth tokens or an API key fallback.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);

      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      if (readOptionalString(auth.OPENAI_API_KEY)) {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid tokens found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Codex not configured' : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}
