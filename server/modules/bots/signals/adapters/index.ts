import { createDirectoryAdapter } from '@/modules/bots/signals/adapters/directory.adapter.js';
import { createGithubAdapter } from '@/modules/bots/signals/adapters/github.adapter.js';
import { createHttpJsonAdapter } from '@/modules/bots/signals/adapters/http-json.adapter.js';
import { registerWatchAdapter } from '@/modules/bots/signals/adapters/registry.js';
import { createRssAdapter } from '@/modules/bots/signals/adapters/rss.adapter.js';

export * from '@/modules/bots/signals/adapters/adapter.types.js';
export { getWatchAdapter, listWatchAdapterKinds, registerWatchAdapter, unregisterWatchAdapter } from '@/modules/bots/signals/adapters/registry.js';
export { createRssAdapter, parseFeed } from '@/modules/bots/signals/adapters/rss.adapter.js';
export { createDirectoryAdapter, validateDirectoryPath } from '@/modules/bots/signals/adapters/directory.adapter.js';
export { createGithubAdapter } from '@/modules/bots/signals/adapters/github.adapter.js';
export { createHttpJsonAdapter } from '@/modules/bots/signals/adapters/http-json.adapter.js';

let registered = false;

/** Registers the built-in adapters once. Safe to call repeatedly. */
export function registerBuiltInWatchAdapters(): void {
  if (registered) return;
  registered = true;
  registerWatchAdapter('rss', createRssAdapter());
  registerWatchAdapter('directory', createDirectoryAdapter());
  registerWatchAdapter('github', createGithubAdapter());
  registerWatchAdapter('http_json', createHttpJsonAdapter());
}
