import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { inspectLoginUrl, loginCommand, shellQuote, forwardingSpecs, createUrlScanner, parseArgs, createBrowserRelay } from '../auth-relay.mjs';

const moduleUrl = new URL('../auth-relay.mjs', import.meta.url);
const authUrl = (origin = 'https://auth.openai.com', callback = 'http://localhost:1455/auth/callback') =>
  `${origin}/oauth/authorize?redirect_uri=${encodeURIComponent(callback)}&state=a%2Bb&code_challenge=test`;

test('provider commands match native CLIs and device-code flags', () => {
  assert.deepEqual(loginCommand('claude'), ['claude', 'auth', 'login']);
  assert.deepEqual(loginCommand('codex'), ['codex', 'login']);
  assert.deepEqual(loginCommand('grok'), ['grok', 'login', '--oauth']);
  for (const provider of ['codex', 'grok']) assert.deepEqual(loginCommand(provider, true), [provider, 'login', '--device-auth']);
  assert.throws(() => loginCommand('claude', true));
  assert.throws(() => loginCommand('invalid'));
});

test('preserves OAuth bytes and handles IPv4, IPv6 and localhost callbacks', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = authUrl(undefined, `http://${host}:1455/auth/callback`);
    const parsed = inspectLoginUrl(url, 'codex');
    assert.equal(parsed.url, url);
    assert.deepEqual(parsed.callback, { host, port: 1455 });
    assert.deepEqual(forwardingSpecs(parsed.callback), host === 'localhost'
      ? ['127.0.0.1:1455:localhost:1455', '[::1]:1455:localhost:1455']
      : [`${host}:1455:${host}:1455`]);
  }
  assert.equal(inspectLoginUrl(authUrl('https://claude.ai', 'https://console.anthropic.com/oauth/code/callback'), 'claude').callback, null);
  assert.equal(inspectLoginUrl(authUrl('https://claude.com', 'https://platform.claude.com/oauth/code/callback'), 'claude').callback, null);
  assert.equal(inspectLoginUrl('https://auth.openai.com/codex/device', 'codex').callback, null);
  assert.equal(inspectLoginUrl('https://auth.x.ai/device?user_code=test', 'grok').callback, null);
});

test('rejects arbitrary open targets, credentials, cross-provider URLs and network forwards', () => {
  for (const url of [
    'file:///etc/passwd', 'https://auth.openai.com.evil.test/oauth/authorize',
    'https://user:password@auth.openai.com/oauth/authorize', 'https://auth.openai.com:444/oauth/authorize',
    'https://auth.openai.com/docs', 'https://auth.x.ai/oauth/authorize',
    authUrl(undefined, 'http://192.168.1.1:8080/callback'),
    authUrl(undefined, 'http://localhost:22/callback'),
    authUrl(undefined, 'http://localhost/callback'),
    authUrl(undefined, 'https://localhost:1455/callback'),
    authUrl(undefined, 'http://user:password@localhost:1455/callback'),
    authUrl(undefined, 'https://evil.test/callback'),
    authUrl() + '\nignored',
  ]) assert.throws(() => inspectLoginUrl(url, 'codex'), url);
});

test('scanner waits for complete output across chunks and strips color sequences', () => {
  const found = [];
  const scan = createUrlScanner((url) => found.push(url));
  const url = authUrl();
  scan('\x1b[32mOpen ' + url.slice(0, 60));
  assert.deepEqual(found, []);
  scan(url.slice(60) + '\x1b[0m\n');
  assert.deepEqual(found, [url]);
  scan('Final: ' + url);
  scan('', true);
  assert.deepEqual(found, [url, url]);
});

test('SSH destinations reject options/shell injection and remote arguments quote literally', () => {
  assert.equal(parseArgs(['claude', '--host', 'me@mac.tailnet.ts.net']).host, 'me@mac.tailnet.ts.net');
  for (const host of ['-oProxyCommand=evil', 'host;evil', 'host\ncommand', '$(evil)']) {
    assert.throws(() => parseArgs(['claude', '--host', host]));
  }
  assert.equal(shellQuote("a'b$(x)`y`"), "'a'\"'\"'b$(x)`y`'");
});

test('local browser opens only after both localhost tunnels are ready, and only once', async () => {
  const calls = [];
  const relay = createBrowserRelay({ provider: 'codex',
    forward: async (spec) => { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push(spec); },
    openBrowser: async (url) => { calls.push(url); },
  });
  const url = authUrl();
  await relay(url);
  await relay(url);
  assert.deepEqual(calls, ['127.0.0.1:1455:localhost:1455', '[::1]:1455:localhost:1455', url]);
});

test('a callback port conflict never opens the browser', async () => {
  let opened = false;
  const relay = createBrowserRelay({ provider: 'codex', forward: async () => { throw new Error('address in use'); },
    openBrowser: async () => { opened = true; },
  });
  await assert.rejects(relay(authUrl()), /Cannot forward callback port 1455/);
  assert.equal(opened, false);
});

test('device-code login opens locally without any callback tunnel', async () => {
  const calls = [];
  const relay = createBrowserRelay({ provider: 'grok', forward: async () => assert.fail('unexpected forward'),
    openBrowser: async (url) => calls.push(url),
  });
  await relay('https://auth.x.ai/device?user_code=fixture');
  assert.deepEqual(calls, ['https://auth.x.ai/device?user_code=fixture']);
});

async function fixture(t, provider, mode = 'hook') {
  const root = path.resolve('tmp/cloudcli');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'auth-test-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const origin = { claude: 'https://claude.ai', codex: 'https://auth.openai.com', grok: 'https://auth.x.ai' }[provider];
  const script = `#!${process.execPath}
import http from 'node:http';
import { spawn } from 'node:child_process';
const server = http.createServer((req, res) => {
  if (!req.url.includes('code=fixture') || !req.url.includes('state=fixture')) { res.writeHead(400).end(); return; }
  res.end('callback delivered');
  console.log('AUTHENTICATED_FIXTURE');
  setTimeout(() => process.exit(0), 30);
});
server.listen(0, '127.0.0.1', async () => {
  const url = ${JSON.stringify(origin)} + '/oauth/authorize?redirect_uri=' + encodeURIComponent('http://127.0.0.1:' + server.address().port + '/callback') + '&state=fixture';
  if (${JSON.stringify(mode)} === 'print') {
    process.stdout.write(url.slice(0, 30));
    setTimeout(() => process.stdout.write(url.slice(30) + '\\n'), 30);
  } else if (${JSON.stringify(mode)} === 'unauthorized') {
    const result = await fetch(process.env.CLOUDCLI_AUTH_RELAY_ENDPOINT, { method: 'POST', body: url });
    console.log('UNAUTHORIZED_STATUS=' + result.status);
    process.exit(result.status === 403 ? 0 : 1);
  } else {
    // Claude prints its manual URL before invoking the opener with a loopback URL.
    if (${JSON.stringify(provider)} === 'claude') {
      const manual = new URL(url);
      manual.searchParams.set('redirect_uri', 'https://platform.claude.com/oauth/code/callback');
      console.log(manual.href);
    } else console.log(url);
    const opener = ${JSON.stringify(provider)} === 'claude' ? 'open' : process.env.BROWSER;
    spawn(opener, [url], { stdio: 'inherit' });
  }
});
process.stdin.on('data', (data) => { if (data.toString().trim() === 'fixture-code') { console.log('CODE_RECEIVED'); process.exit(0); } });
`;
  await writeFile(path.join(bin, provider), script, { mode: 0o700 });
  const source = (await readFile(moduleUrl, 'utf8')).replace(/^#![^\n]*\n/, '');
  // Exercise the same self-contained source bootstrap sent through SSH.
  const runner = spawn(process.execPath, ['--input-type=module', '-e', source, '--', '--remote', provider], {
    cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  runner.stderr.on('data', (data) => { stderr += data; });
  const events = [];
  const waiters = new Set();
  const lines = createInterface({ input: runner.stdout });
  lines.on('line', (line) => {
    const event = JSON.parse(line);
    events.push(event);
    for (const waiter of waiters) waiter(event);
  });
  const closed = new Promise((resolve) => runner.on('close', (code) => resolve(code)));
  t.after(async () => {
    if (runner.exitCode === null) { runner.stdin.end(); await closed; }
    lines.close();
    await rm(dir, { recursive: true, force: true });
    assert.equal(stderr, '');
  });
  const send = (event) => runner.stdin.write(JSON.stringify(event) + '\n');
  const wait = (type) => new Promise((resolve, reject) => {
    const existing = events.find((event) => event.type === type);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + type + ': ' + JSON.stringify(events))), 8000);
    const listener = (event) => {
      if (event.type === type) { clearTimeout(timer); waiters.delete(listener); resolve(event); }
    };
    waiters.add(listener);
  });
  return { runner, events, wait, send, closed, dir };
}

for (const provider of ['claude', 'codex', 'grok']) {
  test(`${provider}: intercept browser, preserve callback and clean up after success`, { timeout: 12000 }, async (t) => {
    const f = await fixture(t, provider);
    const event = await f.wait('url');
    const parsed = inspectLoginUrl(event.url, provider);
    assert.ok(parsed.callback, 'prefer the browser callback over any printed manual-code URL');
    f.send({ type: 'opened', id: event.id, ok: true });
    const redirect = new URL(event.url).searchParams.get('redirect_uri');
    const response = await fetch(redirect + '?code=fixture&state=fixture');
    assert.equal(response.status, 200);
    assert.ok(parsed.callback.port > 1024);
    assert.equal(await f.closed, 0);
    assert.equal(f.events.filter((item) => item.type === 'url').length, 1);
    assert.ok(f.events.some((item) => item.type === 'output' && item.data.includes('AUTHENTICATED_FIXTURE')));
    assert.deepEqual(await readdir(path.join(f.dir, 'tmp/cloudcli')), []);
  });
}

test('printed URL fallback supports paste-code input', { timeout: 12000 }, async (t) => {
  const f = await fixture(t, 'claude', 'print');
  const event = await f.wait('url');
  f.send({ type: 'opened', id: event.id, ok: true });
  f.send({ type: 'input', data: 'fixture-code\n' });
  assert.equal(await f.closed, 0);
  assert.ok(f.events.some((item) => item.type === 'output' && item.data.includes('CODE_RECEIVED')));
});

for (const mode of ['cancel', 'disconnect', 'open-failure']) {
  test(`${mode} stops the remote login and removes temporary files`, { timeout: 12000 }, async (t) => {
    const f = await fixture(t, 'codex');
    const event = await f.wait('url');
    if (mode === 'disconnect') f.runner.stdin.end();
    else if (mode === 'cancel') f.send({ type: 'cancel' });
    else f.send({ type: 'opened', id: event.id, ok: false });
    assert.notEqual(await f.closed, 0);
    assert.deepEqual(await readdir(path.join(f.dir, 'tmp/cloudcli')), []);
    await assert.rejects(fetch(new URL(event.url).searchParams.get('redirect_uri')));
  });
}

test('local opener endpoint requires its per-session secret', { timeout: 12000 }, async (t) => {
  const f = await fixture(t, 'grok', 'unauthorized');
  assert.equal(await f.closed, 0);
  assert.equal(f.events.filter((item) => item.type === 'url').length, 0);
  assert.ok(f.events.some((item) => item.type === 'output' && item.data.includes('UNAUTHORIZED_STATUS=403')));
});
