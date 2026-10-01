import { useEffect, useRef, useState } from 'react';

import { botStudioApi } from '../api/botStudioApi';
import { botRuntimeApi } from '../api/botRuntimeApi';
import type { BotAutonomy, BotChannel, BotEnforcementPreview } from '../types/botRuntime';

import { isObviouslyReadTool, toRiskItem, type ToolRiskItem } from './toolRisk';

type Remote<T> = { data: T | null; loading: boolean; error: string | null };

const messageOf = (caught: unknown, fallback: string): string => (caught instanceof Error && caught.message ? caught.message : fallback);

/** Enforcement level for the chosen provider (and autonomy), refetched when either changes. */
export function useEnforcementPreview(provider: string | undefined, enabled: boolean, autonomy?: BotAutonomy): Remote<BotEnforcementPreview> {
  const [state, setState] = useState<Remote<BotEnforcementPreview>>({ data: null, loading: false, error: null });
  useEffect(() => {
    if (!enabled || !provider) return undefined;
    let cancelled = false;
    setState((current) => ({ data: current.data?.provider === provider ? current.data : null, loading: true, error: null }));
    botRuntimeApi.runtime.enforcementPreview(provider, autonomy)
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((caught: unknown) => { if (!cancelled) setState({ data: null, loading: false, error: messageOf(caught, 'Could not check enforcement.') }); });
    return () => { cancelled = true; };
  }, [enabled, provider, autonomy]);
  return state;
}

/** The shared (global) channels, loaded once while the runtime wizard is on. */
export function useGlobalChannels(enabled: boolean): Remote<BotChannel[]> & { reload: () => void } {
  const [state, setState] = useState<Remote<BotChannel[]>>({ data: null, loading: false, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    botRuntimeApi.channels.list()
      .then((list) => { if (!cancelled) setState({ data: list.channels, loading: false, error: null }); })
      .catch((caught: unknown) => { if (!cancelled) setState({ data: null, loading: false, error: messageOf(caught, 'Could not load channels.') }); });
    return () => { cancelled = true; };
  }, [enabled, nonce]);
  return { ...state, reload: () => setNonce((value) => value + 1) };
}

const CLASSIFY_CONCURRENCY = 5;
const MAX_TOOLS_PER_SERVER = 60;

/**
 * Classifies the tools of every attached server through GET /risk/classify (the server owns the
 * table) so Guardrails can offer "allow this without asking" for the ones the safety floor holds.
 * Obvious read tools are skipped; results are cached per server for the life of the wizard.
 */
export function useToolRisks(servers: string[], enabled: boolean): { items: ToolRiskItem[]; loading: boolean; errors: Record<string, string> } {
  const cache = useRef(new Map<string, ToolRiskItem[]>());
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = servers.join('\u0001');

  useEffect(() => {
    if (!enabled) return undefined;
    const missing = servers.filter((server) => !cache.current.has(server));
    if (missing.length === 0) return undefined;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      for (const server of missing) {
        try {
          const tools = (await botStudioApi.listMcpTools(server)).slice(0, MAX_TOOLS_PER_SERVER);
          const candidates = tools.filter((tool) => !isObviouslyReadTool(tool.name));
          const items: ToolRiskItem[] = [];
          for (let i = 0; i < candidates.length; i += CLASSIFY_CONCURRENCY) {
            const batch = candidates.slice(i, i + CLASSIFY_CONCURRENCY);
            const results = await Promise.all(batch.map(async (tool) => {
              try { return toRiskItem(server, tool, await botRuntimeApi.gate.classify(tool.name, server)); } catch { return null; }
            }));
            for (const item of results) if (item) items.push(item);
            if (cancelled) return;
          }
          cache.current.set(server, items);
        } catch (caught) {
          cache.current.set(server, []);
          if (!cancelled) setErrors((current) => ({ ...current, [server]: messageOf(caught, 'Could not list this server\'s tools.') }));
        }
        if (!cancelled) setVersion((value) => value + 1);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; setLoading(false); };
    // `servers` is represented by `key`; a new array identity with the same names must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  const items = servers.flatMap((server) => cache.current.get(server) ?? []);
  void version;
  return { items, loading, errors };
}
