import { randomBytes } from 'node:crypto';

export interface GatewaySessionBinding {
  botId: string;
  episodeId?: string;
  runId?: string;
  /** Catalog MCP server names this run may see through the gateway. */
  servers: string[];
  provider: string;
  /** True once the run read external-trust content. */
  tainted: boolean;
  /** Random per-binding secret. The provider stamps it on the gateway stdio child; the route checks it. */
  secret: string;
  /** True when the provider stamps `secret` on the gateway child (so the route must see it). */
  secretRequired: boolean;
}

/** Providers whose runtime stamps the binding secret onto the gateway stdio entry (claude-sdk.js, openai-codex.js, grok-cli.js, opencode-cli.js for antigravity). */
export const SECRET_STAMPING_PROVIDERS: readonly string[] = ['claude', 'codex', 'grok', 'antigravity'];

export type GatewaySessionBindInput = Omit<GatewaySessionBinding, 'tainted' | 'secret' | 'secretRequired'> & { tainted?: boolean };

/**
 * Lives in shared/ so Mission Control can bind sessions without importing the bots module (which
 * imports Mission Control). See bots/gateway for the consumer.
 *
 * appSessionId -> bot binding. In-memory only: a server restart drops every binding,
 * so a run that survives the restart gets "unknown session" from the gateway (fail
 * closed) until the kernel rebinds it when it resumes the episode. Bindings are
 * short-lived (one provider run), so nothing is persisted.
 */
const bindings = new Map<string, GatewaySessionBinding>();

export const gatewaySessions = {
  bind(appSessionId: string, input: GatewaySessionBindInput): GatewaySessionBinding {
    const binding: GatewaySessionBinding = {
      botId: input.botId,
      episodeId: input.episodeId,
      runId: input.runId,
      servers: [...new Set(input.servers)],
      provider: input.provider,
      tainted: input.tainted === true,
      secret: randomBytes(24).toString('hex'),
      secretRequired: SECRET_STAMPING_PROVIDERS.includes(String(input.provider)),
    };
    bindings.set(appSessionId, binding);
    return binding;
  },

  unbind(appSessionId: string): boolean {
    return bindings.delete(appSessionId);
  },

  get(appSessionId: string): GatewaySessionBinding | null {
    const binding = bindings.get(appSessionId);
    return binding ? { ...binding, servers: [...binding.servers] } : null;
  },

  markTainted(appSessionId: string): boolean {
    const binding = bindings.get(appSessionId);
    if (!binding) return false;
    binding.tainted = true;
    return true;
  },

  clearForTests(): void {
    bindings.clear();
  },
};
