import type { WatchAdapter } from '@/modules/bots/signals/adapters/adapter.types.js';

const adapters = new Map<string, WatchAdapter>();

export function registerWatchAdapter(kind: string, adapter: WatchAdapter): void {
  adapters.set(kind, adapter);
}

export function getWatchAdapter(kind: string): WatchAdapter | undefined {
  return adapters.get(kind);
}

export function listWatchAdapterKinds(): string[] {
  return [...adapters.keys()].sort();
}

export function unregisterWatchAdapter(kind: string): void {
  adapters.delete(kind);
}
