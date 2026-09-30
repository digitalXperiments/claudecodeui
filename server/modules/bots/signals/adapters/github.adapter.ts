import { execFile } from 'node:child_process';

import {
  asString,
  MAX_EVENTS_PER_POLL,
  type WatchAdapter,
  type WatchEventDraft,
  type WatchExec,
} from '@/modules/bots/signals/adapters/adapter.types.js';

/** owner/name; `..` and bare `.` segments would escape the repos/ API path. */
const REPO_PATTERN = /^(?!.*\.\.)(?!\.\/)(?!.*\/\.$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WHAT = ['issues', 'pulls', 'notifications'] as const;
type What = (typeof WHAT)[number];

const defaultExec: WatchExec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`gh failed: ${error.message.split('\n')[0]}`));
      else resolve({ stdout });
    });
  });

type GhItem = Record<string, unknown>;

function parseList(stdout: string): GhItem[] {
  const parsed: unknown = JSON.parse(stdout || '[]');
  return Array.isArray(parsed) ? (parsed.filter((v) => v && typeof v === 'object') as GhItem[]) : [];
}

function whatList(config: Record<string, unknown>): What[] {
  const raw = Array.isArray(config.what) ? config.what : ['issues', 'pulls'];
  return raw.filter((v): v is What => (WHAT as readonly string[]).includes(String(v)));
}

/** Read-only GitHub watcher. Only `gh api -X GET` is ever invoked. */
export function createGithubAdapter(deps: { exec?: WatchExec } = {}): WatchAdapter {
  const exec = deps.exec ?? defaultExec;
  const get = (endpoint: string) => exec('gh', ['api', '-X', 'GET', endpoint]);
  return {
    validate(config) {
      if (!REPO_PATTERN.test(asString(config.repo))) return 'repo must look like owner/name';
      if (Array.isArray(config.what) && whatList(config).length !== config.what.length) {
        return `what must only contain: ${WHAT.join(', ')}`;
      }
      return null;
    },
    async poll(config, cursor) {
      const repo = asString(config.repo);
      if (!REPO_PATTERN.test(repo)) throw new Error('repo must look like owner/name');
      const initialized = cursor.initialized === true;
      const emitExisting = config.emit_existing === true;
      const last = (cursor.last && typeof cursor.last === 'object' ? cursor.last : {}) as Record<string, string>;
      const nextLast: Record<string, string> = { ...last };
      const events: WatchEventDraft[] = [];
      const errors: string[] = [];

      for (const what of whatList(config)) {
        try {
          let items: GhItem[];
          let timeField = 'created_at';
          if (what === 'issues') {
            items = parseList((await get(`repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=30`)).stdout)
              .filter((item) => !item.pull_request);
          } else if (what === 'pulls') {
            items = parseList((await get(`repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=30`)).stdout);
          } else {
            timeField = 'updated_at';
            items = parseList((await get(`repos/${repo}/notifications?all=false&per_page=30`)).stdout);
          }
          const since = asString(last[what]);
          const fresh = items
            .filter((item) => asString(item[timeField]) > since)
            .sort((a, b) => asString(a[timeField]).localeCompare(asString(b[timeField])));
          const newest = items.map((i) => asString(i[timeField])).sort().pop();
          if (newest && newest > since) nextLast[what] = newest;
          if (!initialized && !emitExisting) continue;
          for (const item of fresh) {
            const id = asString(String(item.number ?? item.id ?? ''));
            const singular = what === 'issues' ? 'issue' : what === 'pulls' ? 'pull_request' : 'notification';
            const subject = (item.subject && typeof item.subject === 'object' ? item.subject : {}) as GhItem;
            events.push({
              source: 'watch:github',
              kind: 'watch',
              dedupeKey: `gh:${repo}:${singular}:${id}:${asString(item[timeField])}`,
              trust: 'external',
              payload: {
                adapter: 'github',
                repo,
                type: singular,
                number: item.number ?? null,
                title: asString(item.title) || asString(subject.title),
                url: asString(item.html_url) || asString(subject.url),
                author: asString((item.user as GhItem | undefined)?.login),
                reason: asString(item.reason) || undefined,
                at: asString(item[timeField]),
              },
            });
          }
        } catch (error) {
          errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (errors.length && events.length === 0 && errors.length === whatList(config).length) {
        throw new Error(errors.join('; '));
      }
      return { events: events.slice(0, MAX_EVENTS_PER_POLL), cursor: { initialized: true, last: nextLast } };
    },
  };
}
