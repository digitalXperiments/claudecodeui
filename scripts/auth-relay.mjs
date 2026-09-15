#!/usr/bin/env node
// Standalone: copy this file to the Mac with your browser. Node 20+ and SSH only.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const MAX_FRAME = 128 * 1024;
const LOGIN_TIMEOUT = 10 * 60 * 1000;
export const PROVIDERS = {
  claude: { command: 'claude', args: ['auth', 'login'], domains: ['claude.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com'] },
  codex: { command: 'codex', args: ['login'], domains: ['auth.openai.com', 'chatgpt.com'] },
  grok: { command: 'grok', args: ['login', '--oauth'], domains: ['auth.x.ai', 'accounts.x.ai', 'grok.com'] },
};

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function loginCommand(provider, deviceAuth = false) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error('Choose claude, codex, or grok.');
  if (deviceAuth && provider === 'claude') throw new Error('Claude does not expose device-code login; use its browser flow.');
  return [entry.command, ...(deviceAuth ? ['login', '--device-auth'] : entry.args)];
}

// Only provider authorization URLs may open a browser or request a forward.
// Never rewrite redirect_uri, state, PKCE, path, or query parameters.
export function inspectLoginUrl(raw, provider) {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\x00-\x1f]/.test(raw)) throw new Error('Invalid login URL.');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !PROVIDERS[provider]?.domains.includes(url.hostname)) throw new Error('Unexpected login URL origin.');
  const redirect = url.searchParams.get('redirect_uri');
  let callback = null;
  if (redirect) {
    const target = new URL(redirect);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (loopback) {
      const port = Number(target.port);
      if (target.protocol !== 'http:' || target.username || target.password || !Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Unsupported localhost callback address.');
      }
      callback = { host: target.hostname, port };
    } else if (target.protocol !== 'https:' || target.username || target.password || target.port ||
        !PROVIDERS[provider].domains.includes(target.hostname)) {
      throw new Error('Unexpected OAuth callback origin.');
    }
  }
  // Ignore links to documentation, home pages, etc. in CLI output.
  if (!redirect && !/\/(?:oauth|authorize|auth|device|activate)(?:\/|$)/i.test(url.pathname)) {
    throw new Error('Not an authorization URL.');
  }
  return { url: raw, callback };
}

export function forwardingSpecs(callback) {
  // Request both bindings separately so a conflict on either family fails closed.
  const bindings = callback.host === 'localhost' ? ['127.0.0.1', '[::1]'] : [callback.host];
  return bindings.map((bind) => `${bind}:${callback.port}:${callback.host}:${callback.port}`);
}

export function createBrowserRelay({ provider, forward, openBrowser }) {
  const forwards = new Set();
  const opened = new Set();
  return async (raw) => {
    const { url, callback } = inspectLoginUrl(raw, provider);
    if (opened.has(url)) return;
    if (callback) {
      for (const spec of forwardingSpecs(callback)) {
        if (forwards.has(spec)) continue;
        try { await forward(spec); }
        catch { throw new Error(`Cannot forward callback port ${callback.port}. Close other logins using that port and check SSH port forwarding is allowed.`); }
        forwards.add(spec);
      }
    }
    await openBrowser(url);
    opened.add(url);
  };
}

export function createUrlScanner(onUrl) {
  let pending = '';
  return (chunk, flush = false) => {
    pending += chunk;
    // CSI colors and OSC hyperlinks, including common CLI terminal output.
    const clean = pending.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const end = flush ? clean.length : Math.max(clean.lastIndexOf('\n'), clean.lastIndexOf('\r')) + 1;
    const complete = clean.slice(0, end);
    pending = clean.slice(end).slice(-32768);
    for (const match of complete.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) {
      onUrl(match[0].replace(/[),.;]+$/, ''));
    }
  };
}

// A private per-login browser opener, inherited only by the child CLI.
// No URL interpolation into a shell, and no credentials written by the relay.
function browserHook() {
  const url = process.argv.slice(2).find((arg) => arg.startsWith('https://'));
  if (!url) process.exit(1);
  fetch(process.env.CLOUDCLI_AUTH_RELAY_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CLOUDCLI_AUTH_RELAY_SECRET}` },
    body: url,
    signal: AbortSignal.timeout(30000),
  }).then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));
}

export async function remoteMain(provider, deviceAuth = false) {
  const [command, ...args] = loginCommand(provider, deviceAuth);
  const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  const root = path.join(process.cwd(), 'tmp', 'cloudcli');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'auth-relay-'));
  const secret = randomBytes(32).toString('hex');
  const requests = new Map();
  const printedUrls = new Map();
  const hookedFlows = new Set();
  let child;
  let stopping = false;
  let timer;
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/open' || req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) { res.writeHead(413).end(); return; }
      }
      inspectLoginUrl(body, provider);
      const flow = flowKey(body);
      hookedFlows.add(flow);
      clearTimeout(printedUrls.get(flow));
      printedUrls.delete(flow);
      const entry = requestUrl(body);
      if (!entry) { res.writeHead(400).end(); return; }
      const ok = await entry.done;
      res.writeHead(ok ? 204 : 502).end();
    } catch { res.writeHead(400).end(); }
  });
  server.requestTimeout = 35000;
  function flowKey(raw) {
    const url = new URL(raw);
    const state = url.searchParams.get('state');
    return state ? `${url.origin}:${url.searchParams.get('client_id')}:${state}` : raw;
  }
  function printedUrl(url) {
    try { inspectLoginUrl(url, provider); } catch { return; }
    const flow = flowKey(url);
    if (hookedFlows.has(flow) || printedUrls.has(flow)) return;
    // Claude prints a manual-code URL before opening a DIFFERENT loopback URL.
    // Give the actual browser hook priority so normal login stays automatic.
    printedUrls.set(flow, setTimeout(() => {
      printedUrls.delete(flow);
      if (!stopping && !hookedFlows.has(flow)) requestUrl(url);
    }, 1500));
  }
  function requestUrl(url) {
    try { inspectLoginUrl(url, provider); } catch { return null; }
    if (requests.has(url)) return requests.get(url);
    if (requests.size >= 8) return null;
    const id = randomBytes(12).toString('hex');
    let resolve;
    const done = new Promise((accept) => { resolve = accept; });
    const entry = { id, done, resolve };
    requests.set(url, entry);
    send({ type: 'url', id, url });
    return entry;
  }
  async function finish(code, message) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    for (const pending of printedUrls.values()) clearTimeout(pending);
    for (const entry of requests.values()) entry.resolve(false);
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      // Kill descendants as well (browser hooks can outlive the CLI).
      await new Promise((resolve) => setTimeout(resolve, 200));
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    reader.close();
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
    send({ type: 'exit', code, ...(message ? { message } : {}) });
    process.exit(code);
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const hook = `#!${process.execPath}\n(${browserHook.toString()})();\n`;
    for (const name of ['open', 'xdg-open', 'browser']) await writeFile(path.join(dir, name), hook, { mode: 0o700 });
    reader.on('line', (line) => {
      if (line.length > MAX_FRAME) { void finish(1, 'Relay frame too large.'); return; }
      try {
        const event = JSON.parse(line);
        if (event.type === 'opened') {
          for (const entry of requests.values()) if (entry.id === event.id) entry.resolve(event.ok === true);
          if (!event.ok) void finish(1, 'Local browser or callback tunnel failed.');
        } else if (event.type === 'input' && typeof event.data === 'string') child?.stdin.write(event.data);
        else if (event.type === 'cancel') void finish(130, 'Login cancelled.');
      } catch { void finish(1, 'Invalid relay message.'); }
    });
    reader.on('close', () => { if (!stopping) void finish(130, 'Relay disconnected.'); });
    process.on('SIGTERM', () => void finish(130, 'Login cancelled.'));
    process.on('SIGHUP', () => void finish(130, 'Relay disconnected.'));
    process.stdout.on('error', () => void finish(1));
    timer = setTimeout(() => void finish(1, 'Login timed out after 10 minutes.'), LOGIN_TIMEOUT);
    child = spawn(command, args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH || ''}`,
        BROWSER: path.join(dir, 'browser'),
        CLOUDCLI_AUTH_RELAY_ENDPOINT: `http://127.0.0.1:${server.address().port}/open`,
        CLOUDCLI_AUTH_RELAY_SECRET: secret,
        NO_COLOR: '1', FORCE_COLOR: '0',
      },
    });
    for (const [stream, output] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const scan = createUrlScanner(printedUrl);
      output.setEncoding('utf8');
      output.on('data', (data) => { send({ type: 'output', stream, data }); scan(data); });
      output.on('end', () => scan('', true));
    }
    child.on('error', () => void finish(1, `Cannot start ${command}. Check it is installed and on the remote PATH.`));
    child.on('close', (code) => void finish(code ?? 1));
    send({ type: 'ready', provider });
  } catch {
    await finish(1, 'Could not initialize the remote login relay.');
  }
}

export function parseArgs(args) {
  const options = { host: process.env.CLOUDCLI_AUTH_HOST, remoteNode: 'node', deviceAuth: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' || arg === '--remote-node') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}.`);
      options[arg === '--host' ? 'host' : 'remoteNode'] = value;
    } else if (arg === '--device-auth') options.deviceAuth = true;
    else if (!options.provider && Object.hasOwn(PROVIDERS, arg)) options.provider = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  loginCommand(options.provider, options.deviceAuth);
  if (!options.host || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.host)) {
    throw new Error('Provide --host user@tailscale-host (or set CLOUDCLI_AUTH_HOST). SSH config aliases are supported.');
  }
  return options;
}

export async function localMain(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node auth-relay.mjs <claude|codex|grok> --host user@headless-mac

Run on the Mac with your browser. Requires Node 20+ on both Macs and SSH access.
The helper starts the remote login and opens your browser automatically.

  --host HOST          SSH destination (defaults to CLOUDCLI_AUTH_HOST)
  --device-auth        Use device-code login for Codex or Grok
  --remote-node PATH   Remote Node executable (default: node from login shell)

Keep this terminal open until login completes. Ctrl+C cancels and cleans up.
If Claude asks for a code, paste it into this terminal.`);
    return 0;
  }
  const options = parseArgs(args);
  const root = path.resolve('tmp/cloudcli');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'ar-'));
  const socket = path.join(dir, 's');
  if (Buffer.byteLength(socket) > 100) {
    await rm(dir, { recursive: true, force: true });
    throw new Error('Working directory is too long for an SSH socket. Run from a shorter directory.');
  }
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  // SSH executes a command through a shell: quote every argument, including source.
  // Source contains no secrets. The one-time broker secret stays on the remote Mac.
  const remote = `${shellQuote(options.remoteNode)} --input-type=module -e ${shellQuote(source.replace(/^#![^\n]*\n/, ''))} -- --remote ${options.provider}${options.deviceAuth ? ' --device-auth' : ''}`;
  const command = `exec "$SHELL" -lc ${shellQuote(remote)}`;
  const ssh = spawn('ssh', ['-T', '-o', 'ControlMaster=yes', '-o', `ControlPath=${socket}`,
    '-o', 'ControlPersist=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', options.host, command], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (event) => { if (!ssh.stdin.destroyed) ssh.stdin.write(JSON.stringify(event) + '\n'); };
  ssh.stdin.on('error', () => {});
  let queue = Promise.resolve();
  let result = null;
  let failure = null;
  let ready = false;
  let cancelled = false;
  let killTimer;
  const openLogin = createBrowserRelay({
    provider: options.provider,
    forward: (spec) => exec('ssh', ['-S', socket, '-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', spec, options.host], { timeout: 15000 }),
    openBrowser: async (url) => {
      if (cancelled || result !== null) throw new Error('Login ended before browser launch.');
      try { await exec(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { timeout: 15000 }); }
      catch { throw new Error('Could not open your local browser. Run the relay from a desktop session.'); }
    },
  });
  const input = (data) => send({ type: 'input', data: data.toString() });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    send({ type: 'cancel' });
    ssh.stdin.end();
    killTimer = setTimeout(() => ssh.kill('SIGTERM'), 2000);
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const timeout = setTimeout(() => { failure = new Error('Login timed out after 10 minutes.'); cancel(); }, LOGIN_TIMEOUT + 15000);
  const reader = createInterface({ input: ssh.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    // Login-shell startup banners are not protocol messages.
    if (!line.startsWith('{')) return;
    if (line.length > MAX_FRAME) { failure = new Error('Relay frame too large.'); cancel(); return; }
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'ready') {
      ready = true;
      process.stdin.on('data', input);
      console.error(`Starting ${options.provider} login on ${options.host}.`);
    } else if (event.type === 'output' && typeof event.data === 'string') {
      (event.stream === 'stderr' ? process.stderr : process.stdout).write(event.data);
    } else if (event.type === 'exit') {
      result = Number.isInteger(event.code) ? event.code : 1;
      if (event.message) console.error(event.message);
    } else if (event.type === 'url') {
      queue = queue.then(async () => {
        if (cancelled || result !== null) return;
        await openLogin(event.url);
        console.error('Browser opened locally. Complete the sign-in in that window.');
        send({ type: 'opened', id: event.id, ok: true });
      }).catch((error) => {
        failure = error;
        send({ type: 'opened', id: event.id, ok: false });
        cancel();
      });
    }
  });
  try {
    const code = await new Promise((resolve, reject) => { ssh.once('error', reject); ssh.once('close', resolve); });
    await queue;
    if (failure) throw failure;
    if (!ready) throw new Error('SSH relay did not start. Check SSH access and Node 20+ on the remote login-shell PATH; use --remote-node if needed.');
    const status = result ?? (cancelled ? 130 : code || 1);
    if (status === 0) console.error(`Login completed on ${options.host}. Credentials were saved there by ${options.provider}.`);
    return status;
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    process.stdin.off('data', input);
    process.stdin.pause();
    reader.close();
    ssh.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === '--remote') {
  remoteMain(process.argv[2], process.argv.includes('--device-auth')).catch(() => process.exit(1));
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  localMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Auth relay: ${error.message}`);
    process.exitCode = 1;
  });
}
