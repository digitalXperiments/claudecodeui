import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type GrokCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

/**
 * Grok historically used numeric epoch seconds; current auth.json uses ISO
 * strings like `2026-07-29T23:49:31.590517Z`. Accept both.
 */
const parseExpiryMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) {
      return asDate;
    }
  }
  return null;
};

export class GrokProviderAuth implements IProviderAuth {
  /**
   * Checks whether the grok CLI is available on this host.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('grok', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error;
    } catch {
      return false;
    }
  }

  /**
   * Returns Grok CLI installation and login status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'grok',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads ~/.grok/auth.json and checks for a usable credential entry.
   *
   * auth.json is keyed by `<issuer>::<uuid>` rather than a fixed field name, so
   * every entry is scanned. A non-empty refresh_token keeps the session valid
   * even when the short-lived access token (`expires_at`) has lapsed — the CLI
   * refreshes on use, same as Kimi/Claude.
   */
  private async checkCredentials(): Promise<GrokCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.grok', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      let best: { email: string | null; expiresAt: number } | null = null;
      const now = Date.now();

      for (const rawEntry of Object.values(auth)) {
        const entry = readObjectRecord(rawEntry);
        if (!entry) {
          continue;
        }

        const accessToken = readOptionalString(entry.access_token) ?? readOptionalString(entry.key);
        const refreshToken = readOptionalString(entry.refresh_token);
        if (!accessToken && !refreshToken) {
          continue;
        }

        const expiresAt = parseExpiryMs(entry.expires_at);
        const accessExpired = expiresAt !== null && expiresAt < now;
        // Keep logged-in when refresh_token can still mint a new access token.
        if (accessExpired && !refreshToken) {
          continue;
        }

        const email = readOptionalString(entry.email) ?? null;
        const sortKey = expiresAt ?? 0;
        if (!best || sortKey >= best.expiresAt) {
          best = { email, expiresAt: sortKey };
        }
      }

      if (best) {
        return { authenticated: true, email: best.email ?? 'Authenticated', method: 'oauth' };
      }

      return { authenticated: false, email: null, method: null, error: 'Not logged in' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Grok not configured' : error instanceof Error ? error.message : 'Failed to read Grok auth',
      };
    }
  }
}
