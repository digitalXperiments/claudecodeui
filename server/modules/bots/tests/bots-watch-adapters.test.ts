import assert from 'node:assert/strict';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createDirectoryAdapter,
  createGithubAdapter,
  createHttpJsonAdapter,
  createRssAdapter,
  parseFeed,
  validateDirectoryPath,
  type WatchExec,
  type WatchFetch,
} from '@/modules/bots/signals/adapters/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

const fakeFetch = (body: string | (() => string), status = 200): WatchFetch => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'function' ? body() : body),
});

const RSS = (ids: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
${ids
  .map(
    (id) => `<item><title><![CDATA[Post ${id} &amp; more]]></title><link>https://example.com/${id}</link>
<guid isPermaLink="false">${id}</guid><pubDate>Mon, 0${id.length} Sep 2026 10:00:00 GMT</pubDate>
<description>&lt;p&gt;Body of ${id}&lt;/p&gt;</description></item>`,
  )
  .join('\n')}</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
<entry><title>Alpha</title><id>urn:a</id><link rel="alternate" href="https://example.com/a"/><link rel="self" href="https://example.com/self"/>
<updated>2026-09-01T10:00:00Z</updated><summary>Hello &amp; welcome</summary></entry>
<entry><title>Beta</title><id>urn:b</id><link href="https://example.com/b"/><published>2026-09-02T10:00:00Z</published></entry></feed>`;

test('parseFeed reads RSS with CDATA/entities and Atom links', () => {
  const rss = parseFeed(RSS(['p1']));
  assert.equal(rss.length, 1);
  assert.equal(rss[0].id, 'p1');
  assert.equal(rss[0].title, 'Post p1 & more');
  assert.equal(rss[0].link, 'https://example.com/p1');
  assert.equal(rss[0].summary, 'Body of p1');

  const atom = parseFeed(ATOM);
  assert.deepEqual(atom.map((i) => [i.id, i.link, i.title]), [
    ['urn:a', 'https://example.com/a', 'Alpha'],
    ['urn:b', 'https://example.com/b', 'Beta'],
  ]);
  assert.equal(atom[0].summary, 'Hello & welcome');
  assert.deepEqual(parseFeed('not xml at all'), []);
});

test('rss adapter baselines on first poll, then emits only new items (external trust)', async () => {
  let ids = ['a', 'b'];
  const adapter = createRssAdapter({ fetch: fakeFetch(() => RSS(ids)) });
  const config = { url: 'https://example.com/feed.xml' };
  assert.equal(adapter.validate?.(config), null);
  assert.match(adapter.validate?.({ url: 'ftp://x' }) ?? '', /http/);

  const first = await adapter.poll(config, {});
  assert.equal(first.events.length, 0);
  assert.equal(first.cursor.initialized, true);

  ids = ['c', 'a', 'b'];
  const second = await adapter.poll(config, first.cursor);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].trust, 'external');
  assert.equal(second.events[0].kind, 'watch');
  assert.equal((second.events[0].payload as { id: string }).id, 'c');
  assert.match(second.events[0].dedupeKey ?? '', /rss:.*:c$/);

  const third = await adapter.poll(config, second.cursor);
  assert.equal(third.events.length, 0);
});

test('rss adapter caps a burst at 50 events per poll and can emit existing items on demand', async () => {
  const many = Array.from({ length: 80 }, (_, i) => `n${i}`);
  const adapter = createRssAdapter({ fetch: fakeFetch(() => RSS(many)) });
  const result = await adapter.poll({ url: 'https://example.com/f', emit_existing: true }, {});
  assert.equal(result.events.length, 50);
});

test('rss adapter surfaces HTTP errors without leaking the query string', async () => {
  const adapter = createRssAdapter({ fetch: fakeFetch('nope', 500) });
  await assert.rejects(
    adapter.poll({ url: 'https://example.com/feed?token=SECRET123' }, {}),
    (error: Error) => /HTTP 500/.test(error.message) && !error.message.includes('SECRET123'),
  );
});

test('directory adapter reports added and changed files, ignores dotfiles, never uses fs.watch', async () => {
  const dir = await makeScratchDir('bots-dir-');
  try {
    const adapter = createDirectoryAdapter({ home: '/nonexistent-home' });
    await writeFile(path.join(dir, 'a.txt'), 'one');
    await writeFile(path.join(dir, '.hidden'), 'x');
    await mkdir(path.join(dir, 'sub'));

    const first = await adapter.poll({ path: dir }, {});
    assert.equal(first.events.length, 0);
    assert.deepEqual(Object.keys(first.cursor.files as object), ['a.txt']);

    await writeFile(path.join(dir, 'b.txt'), 'two');
    const future = new Date(Date.now() + 10_000);
    await utimes(path.join(dir, 'a.txt'), future, future);
    const second = await adapter.poll({ path: dir }, first.cursor);
    const byName = Object.fromEntries(second.events.map((e) => [(e.payload as { name: string }).name, (e.payload as { change: string }).change]));
    assert.deepEqual(byName, { 'a.txt': 'changed', 'b.txt': 'added' });
    assert.ok(second.events.every((e) => e.trust === 'external'));

    const third = await adapter.poll({ path: dir }, second.cursor);
    assert.equal(third.events.length, 0);

    await rm(path.join(dir, 'b.txt'));
    const fourth = await adapter.poll({ path: dir }, third.cursor);
    assert.equal(fourth.events.length, 0);
    assert.deepEqual(Object.keys(fourth.cursor.files as object), ['a.txt']);

    const filtered = await adapter.poll({ path: dir, pattern: '\\.md$', emit_existing: true }, {});
    assert.equal(filtered.events.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('directory adapter rejects macOS TCC folders (validation and poll time)', async () => {
  const home = '/Users/someone';
  for (const folder of ['Documents', 'Desktop', 'Downloads']) {
    assert.match(validateDirectoryPath(`${home}/${folder}`, home) ?? '', new RegExp(`~/${folder}`));
    assert.match(validateDirectoryPath(`${home}/${folder}/project/x`, home) ?? '', /privacy/);
    assert.match(validateDirectoryPath(`~/${folder.toLowerCase()}`, home) ?? '', /privacy/);
  }
  assert.equal(validateDirectoryPath(`${home}/Development/x`, home), null);
  assert.equal(validateDirectoryPath(`${home}/DocumentsArchive`, home), null);
  assert.match(validateDirectoryPath('', home) ?? '', /required/);

  const adapter = createDirectoryAdapter({ home });
  assert.match(adapter.validate?.({ path: `${home}/Downloads` }) ?? '', /Downloads/);
  await assert.rejects(adapter.poll({ path: `${home}/Desktop` }, {}), /Desktop/);
});

test('github adapter uses read-only gh api GET calls and reports new issues and PRs', async () => {
  const calls: string[][] = [];
  let issues = [{ number: 1, title: 'old', created_at: '2026-09-01T00:00:00Z', html_url: 'u1', user: { login: 'a' } }];
  let pulls = [{ number: 5, title: 'pr', created_at: '2026-09-01T00:00:00Z', html_url: 'u5', user: { login: 'b' } }];
  const exec: WatchExec = async (file, args) => {
    calls.push([file, ...args]);
    const endpoint = args[args.length - 1];
    if (endpoint.includes('/issues?')) {
      // The issues API also returns pull requests; they must be filtered out.
      return { stdout: JSON.stringify([...issues, { number: 5, title: 'pr', created_at: '2026-09-01T00:00:00Z', pull_request: {} }]) };
    }
    if (endpoint.includes('/pulls?')) return { stdout: JSON.stringify(pulls) };
    return { stdout: '[]' };
  };
  const adapter = createGithubAdapter({ exec });
  const config = { repo: 'acme/widgets' };
  assert.equal(adapter.validate?.(config), null);
  assert.match(adapter.validate?.({ repo: 'bad repo; rm -rf' }) ?? '', /owner\/name/);
  assert.match(adapter.validate?.({ repo: 'a/b', what: ['issues', 'delete'] }) ?? '', /what must/);

  const first = await adapter.poll(config, {});
  assert.equal(first.events.length, 0);

  issues = [{ number: 2, title: 'new issue', created_at: '2026-09-02T00:00:00Z', html_url: 'u2', user: { login: 'c' } }, ...issues];
  pulls = [{ number: 6, title: 'new pr', created_at: '2026-09-03T00:00:00Z', html_url: 'u6', user: { login: 'd' } }, ...pulls];
  const second = await adapter.poll(config, first.cursor);
  assert.deepEqual(
    second.events.map((e) => [(e.payload as { type: string }).type, (e.payload as { number: number }).number, e.trust]),
    [['issue', 2, 'external'], ['pull_request', 6, 'external']],
  );
  const third = await adapter.poll(config, second.cursor);
  assert.equal(third.events.length, 0);

  assert.ok(calls.every((c) => c[0] === 'gh' && c[1] === 'api' && c[2] === '-X' && c[3] === 'GET'));
  assert.ok(calls.every((c) => !c.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a))));
});

test('github adapter reports notifications and fails only when every endpoint fails', async () => {
  const exec: WatchExec = async (_f, args) => {
    const endpoint = args[args.length - 1];
    if (endpoint.includes('/notifications')) {
      return { stdout: JSON.stringify([{ id: '9', updated_at: '2026-09-05T00:00:00Z', reason: 'mention', subject: { title: 'Ping', url: 'api/x' } }]) };
    }
    throw new Error('gh failed: boom');
  };
  const adapter = createGithubAdapter({ exec });
  const result = await adapter.poll({ repo: 'a/b', what: ['issues', 'notifications'], emit_existing: true }, {});
  assert.equal(result.events.length, 1);
  assert.equal((result.events[0].payload as { type: string }).type, 'notification');

  const failing = createGithubAdapter({ exec: async () => { throw new Error('gh failed: not logged in'); } });
  await assert.rejects(failing.poll({ repo: 'a/b' }, {}), /not logged in/);
});

test('http_json adapter resolves secret headers, diffs by id_field and never leaks the secret', async () => {
  let seenHeaders: Record<string, string> | undefined;
  let payload: unknown = { data: { rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] } };
  const fetchImpl: WatchFetch = async (_url, init) => {
    seenHeaders = init?.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const adapter = createHttpJsonAdapter({
    fetch: fetchImpl,
    resolveSecrets: (headers) =>
      Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace('${secret:API_KEY}', 'sk-real-value')])),
  });
  const config = {
    url: 'https://api.example.com/items',
    id_field: 'id',
    items_path: 'data.rows',
    headers: { Authorization: 'Bearer ${secret:API_KEY}' },
  };
  assert.equal(adapter.validate?.(config), null);
  assert.match(adapter.validate?.({ url: 'https://x' }) ?? '', /id_field/);

  const first = await adapter.poll(config, {});
  assert.equal(first.events.length, 0);
  assert.equal(seenHeaders?.Authorization, 'Bearer sk-real-value');

  payload = { data: { rows: [{ id: 3, v: 'c' }, { id: 1, v: 'a' }, { id: 2, v: 'b' }] } };
  const second = await adapter.poll(config, first.cursor);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].trust, 'external');
  assert.deepEqual((second.events[0].payload as { item: object }).item, { id: 3, v: 'c' });
  assert.ok(!JSON.stringify(second).includes('sk-real-value'));

  payload = { not: 'an array' };
  await assert.rejects(adapter.poll(config, second.cursor), /JSON array/);
});
