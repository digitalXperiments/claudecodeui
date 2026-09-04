import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

import {
  ANTIGRAVITY_SETUP_TIMEOUT_MS,
  probeAntigravityAcp,
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
 * The authoritative signal for the second is ACP itself: `initialize` advertises
 * `authMethods` while the agent still needs credentials and stops advertising
 * them once it is signed in. That avoids guessing at a credential file path
 * whose location we have not verified.
 *
 * Everything here is reported as data. An unsupported host, a missing runtime,
 * a bad override and "signed out" are all normal states with their own message
 * — none of them throw, per the providers module contract.
 */
export class AntigravityProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
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

    const authenticated = probe.authMethods.length === 0;
    return {
      installed: true,
      provider: 'antigravity',
      authenticated,
      // ACP does not expose the signed-in account, so claiming an address would
      // be invention; report the method that is in force instead.
      email: authenticated ? 'Signed in with Google' : null,
      method: authenticated ? config.authMethod : null,
      error: authenticated ? undefined : 'Antigravity is not signed in. Use Sign in with Google in Settings.',
    };
  }

  /** Whether the managed runtime (as opposed to any runtime) is present. */
  isManagedRuntimeInstalled(): boolean {
    return isAntigravityRuntimeInstalled(antigravityRuntimeVersion());
  }

  private async probe(): Promise<{ reachable: boolean; authMethods: { id: string; name?: string }[]; error?: string }> {
    try {
      const result = await probeAntigravityAcp();
      return { reachable: true, authMethods: result.authMethods };
    } catch (error) {
      return { reachable: false, authMethods: [], error: (error as Error)?.message || String(error) };
    }
  }
}
