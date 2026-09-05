import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

import {
  ANTIGRAVITY_SETUP_TIMEOUT_MS,
  probeAntigravitySignIn,
} from './antigravity-acp.js';
import {
  antigravityRuntimeVersion,
  antigravityUnsupportedPlatformMessage,
  isAntigravityRuntimeInstalled,
  readAntigravityRuntimeConfig,
  resolveAntigravityBinary,
} from './antigravity-runtime.js';
import { antigravityPlatformKey } from './antigravity-releases.js';

/**
 * Antigravity auth has two independent states, and conflating them is what
 * makes provider setup confusing:
 *
 *  - `installed` — is there a usable ACP executable (managed runtime, explicit
 *    override, or PATH)?
 *  - `authenticated` — has the user completed personal-Google sign-in?
 *
 * The authoritative signal for the second is ACP `authenticate` on a fresh
 * child (see `probeAntigravitySignIn`). `initialize`'s `authMethods` is NOT a
 * signal: Antigravity 1.1.1 lists all four methods whether or not a token is
 * stored, which is what once kept Settings on "not signed in" forever after a
 * successful Google round-trip.
 *
 * Everything here is reported as data. An unsupported host, a missing runtime,
 * a bad override and "signed out" are all normal states with their own message
 * — none of them throw, per the providers module contract.
 */
const AUTHENTICATED_CACHE_TTL_MS = 30_000;
const UNAUTHENTICATED_CACHE_TTL_MS = 3_000;

let cachedStatus: { at: number; value: ProviderAuthStatus } | null = null;
let inFlightStatus: Promise<ProviderAuthStatus> | null = null;

export function resetAntigravityAuthCacheForTests(): void {
  cachedStatus = null;
  inFlightStatus = null;
}

export class AntigravityProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const now = Date.now();
    if (cachedStatus) {
      const ttl = cachedStatus.value.authenticated ? AUTHENTICATED_CACHE_TTL_MS : UNAUTHENTICATED_CACHE_TTL_MS;
      if (now - cachedStatus.at < ttl) {
        return cachedStatus.value;
      }
    }

    if (inFlightStatus) {
      return inFlightStatus;
    }

    inFlightStatus = this.detectStatus().finally(() => {
      inFlightStatus = null;
    });

    return inFlightStatus;
  }

  private async detectStatus(): Promise<ProviderAuthStatus> {
    const status = await this.computeStatus();
    cachedStatus = { at: Date.now(), value: status };
    return status;
  }

  private async computeStatus(): Promise<ProviderAuthStatus> {
    const env = process.env;

    // Intel Macs (and other hosts Google does not build for) stay listed with
    // an explicit reason rather than vanishing from the provider list.
    if (!antigravityPlatformKey()) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: antigravityUnsupportedPlatformMessage(),
      };
    }

    const resolution = resolveAntigravityBinary(env);
    if (!resolution.ok) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: resolution.message,
      };
    }

    const config = readAntigravityRuntimeConfig(env);
    const probe = await this.probe();

    if (!probe.reachable) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: probe.error
          ?? `The Antigravity ACP server did not answer initialize within ${ANTIGRAVITY_SETUP_TIMEOUT_MS / 1000}s.`,
      };
    }

    const authenticated = probe.authenticated;
    const error = authenticated
      ? undefined
      : probe.reason === 'rpc-error' || probe.reason === 'timeout'
        ? `Antigravity could not verify its Google sign-in: ${probe.error ?? probe.reason}. Try Sign in with Google again.`
        : 'Antigravity is not signed in. Use Sign in with Google in Settings.';
    return {
      installed: true,
      provider: 'antigravity',
      authenticated,
      // ACP does not expose the signed-in account, so claiming an address would
      // be invention; report the method that is in force instead.
      email: authenticated ? 'Signed in with Google' : null,
      method: authenticated ? config.authMethod : null,
      error,
    };
  }

  /** Whether the managed runtime (as opposed to any runtime) is present. */
  isManagedRuntimeInstalled(): boolean {
    return isAntigravityRuntimeInstalled(antigravityRuntimeVersion());
  }

  private async probe(): Promise<
    | { reachable: true; authenticated: boolean; reason: string; error: string | null }
    | { reachable: false; authenticated: false; reason: 'unreachable'; error?: string }
  > {
    try {
      const result = await probeAntigravitySignIn();
      return { reachable: true, authenticated: result.authenticated, reason: result.reason, error: result.error };
    } catch (error) {
      return { reachable: false, authenticated: false, reason: 'unreachable', error: (error as Error)?.message || String(error) };
    }
  }
}
