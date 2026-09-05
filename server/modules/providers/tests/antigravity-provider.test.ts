import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';
import { makeScratchDir } from '@/shared/scratch.js';
import { antigravityTitleFromPrompt } from '@/modules/providers/list/antigravity/antigravity-conversation-store.js';
import {
  extractOauthUrl,
  isLoopbackReturnUrl,
  probeAntigravityAcp,
  probeAntigravitySignIn,
} from '@/modules/providers/list/antigravity/antigravity-acp.js';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  buildAntigravityLaunchEnv,
  parseAntigravityAuthorizationUrl,
} from '@/modules/providers/list/antigravity/antigravity-auth-support.js';
import {
  installAntigravityRuntime,
  sha256File,
} from '@/modules/providers/list/antigravity/antigravity-installer.js';
import { parseAntigravityModelCatalog } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import {
  ANTIGRAVITY_HARNESS_NAME,
  antigravityAcpArgs,
  antigravityInstallRoot,
  isAntigravityRuntimeInstalled,
  readAntigravityInstallMarker,
  resolveAntigravityBinary,
} from '@/modules/providers/list/antigravity/antigravity-runtime.js';
import {
  antigravityPlatformKey,
  isUsableArtifactPin,
  resolveAntigravityArtifact,
} from '@/modules/providers/list/antigravity/antigravity-releases.js';
import {
  ANTIGRAVITY_ANNOUNCED_PATH_KEY,
  AntigravitySessionsProvider,
  antigravityAnnouncedToolPath,
  isMisattributedDenial,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { AntigravitySkillsProvider } from '@/modules/providers/list/antigravity/antigravity-skills.provider.js';
import { AntigravityProviderAuth, resetAntigravityAuthCacheForTests } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';

const VERSION = '1.1.1';

/**
 * Build a fake Antigravity archive on disk and return everything the installer
 * needs to accept it. No network is touched: the installer's `download` hook is
 * replaced with a local copy, so the download/verify/extract pipeline runs end
 * to end against real bytes and a real pin.
 */
async function createFakeArchive(root: string): Promise<{ archivePath: string; sha256: string; size: number }> {
  const payloadDir = path.join(root, 'payload', 'antigravity-1.1.1');
  await mkdir(payloadDir, { recursive: true });
  await writeFile(path.join(payloadDir, 'agy_acp_server'), '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path.join(payloadDir, 'agy_acp_server'), 0o755);
  await writeFile(path.join(payloadDir, ANTIGRAVITY_HARNESS_NAME), 'harness payload\n', 'utf8');
  // An extra file the installer must NOT copy into the version directory.
  await writeFile(path.join(payloadDir, 'README.txt'), 'ignore me\n', 'utf8');

  const archivePath = path.join(root, 'antigravity-1.1.1-darwin-arm64.tar.gz');
  const result = spawnSync('tar', ['-czf', archivePath, '-C', path.join(root, 'payload'), 'antigravity-1.1.1']);
  assert.equal(result.status, 0, `tar failed: ${result.stderr?.toString() ?? ''}`);

  return {
    archivePath,
    sha256: await sha256File(archivePath),
    size: (await stat(archivePath)).size,
  };
}

async function writeManifest(
  root: string,
  pin: { url: string; sha256: string; size: number },
): Promise<string> {
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({ version: VERSION, artifacts: { 'darwin-arm64': pin } }),
    'utf8',
  );
  return manifestPath;
}

const copyingDownload = (archivePath: string) =>
  async (_url: string, destPath: string, onBytes: (received: number, total: number) => void) => {
    const bytes = await readFile(archivePath);
    await writeFile(destPath, bytes);
    onBytes(bytes.length, bytes.length);
  };

describe('Antigravity release pins', () => {
  it('maps supported hosts and refuses Intel Macs', () => {
    assert.equal(antigravityPlatformKey('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(antigravityPlatformKey('linux', 'x64'), 'linux-x64');
    assert.equal(antigravityPlatformKey('linux', 'arm64'), 'linux-arm64');
    assert.equal(antigravityPlatformKey('win32', 'x64'), 'win32-x64');
    assert.equal(antigravityPlatformKey('win32', 'arm64'), 'win32-arm64');
    // Google publishes no Intel Mac runtime and CloudCLI must not invent a URL.
    assert.equal(antigravityPlatformKey('darwin', 'x64'), null);
    assert.equal(antigravityPlatformKey('freebsd', 'x64'), null);
  });

  it('treats a half-filled pin as absent so nothing installs unverified', () => {
    const good = { url: 'https://example.test/a.zip', sha256: 'a'.repeat(64), size: 10 };
    assert.equal(isUsableArtifactPin(good), true);
    assert.equal(isUsableArtifactPin({ ...good, sha256: '' }), false);
    assert.equal(isUsableArtifactPin({ ...good, size: 0 }), false);
    assert.equal(isUsableArtifactPin({ ...good, url: 'http://example.test/a.zip' }), false);
    assert.equal(isUsableArtifactPin({ ...good, sha256: 'abc' }), false);
    assert.equal(isUsableArtifactPin(null), false);
  });

  it('ignores a malformed manifest override rather than throwing', async () => {
    const root = await makeScratchDir('antigravity-manifest-');
    try {
      const manifestPath = path.join(root, 'broken.json');
      await writeFile(manifestPath, '{not json', 'utf8');
      const env = { CLOUDCLI_ANTIGRAVITY_MANIFEST: manifestPath } as NodeJS.ProcessEnv;
      // Falls back to the built-in pins, which currently carry no entry.
      assert.equal(resolveAntigravityArtifact('darwin-arm64', env), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Antigravity installer', () => {
  it('verifies size and SHA-256, then extracts both payloads', async () => {
    const root = await makeScratchDir('antigravity-install-');
    try {
      const archive = await createFakeArchive(root);
      const manifestPath = await writeManifest(root, {
        url: 'https://example.test/antigravity-1.1.1-darwin-arm64.tar.gz',
        sha256: archive.sha256,
        size: archive.size,
      });
      const env = {
        CLOUDCLI_ANTIGRAVITY_MANIFEST: manifestPath,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
      } as NodeJS.ProcessEnv;

      const phases: string[] = [];
      const result = await installAntigravityRuntime({
        env,
        platform: 'darwin',
        arch: 'arm64',
        download: copyingDownload(archive.archivePath),
        onProgress: (progress) => phases.push(progress.phase),
      });

      assert.equal(result.version, VERSION);
      assert.equal(result.alreadyInstalled, false);
      assert.equal(path.basename(result.executablePath), 'agy_acp_server');
      assert.equal(path.basename(result.harnessPath), ANTIGRAVITY_HARNESS_NAME);
      // Both payloads land flat in the version directory, nested archive
      // layout notwithstanding.
      assert.equal(path.dirname(result.executablePath), path.join(root, 'runtime', VERSION));
      assert.equal(path.dirname(result.harnessPath), path.join(root, 'runtime', VERSION));
      assert.ok((await stat(result.harnessPath)).isFile());
      assert.ok(phases.includes('verify'));
      assert.ok(phases.includes('extract'));

      const marker = readAntigravityInstallMarker(VERSION, env);
      assert.equal(marker?.version, VERSION);
      assert.equal(marker?.platformKey, 'darwin-arm64');
      assert.equal(marker?.sha256, archive.sha256);
      assert.equal(marker?.size, archive.size);
      assert.equal(isAntigravityRuntimeInstalled(VERSION, env), true);

      // The archive's unrelated files are not copied into the runtime.
      await assert.rejects(stat(path.join(root, 'runtime', VERSION, 'README.txt')));

      // A second install is a no-op unless forced.
      const again = await installAntigravityRuntime({
        env,
        platform: 'darwin',
        arch: 'arm64',
        download: async () => assert.fail('must not download when already installed'),
      });
      assert.equal(again.alreadyInstalled, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a checksum mismatch and leaves nothing installed', async () => {
    const root = await makeScratchDir('antigravity-badhash-');
    try {
      const archive = await createFakeArchive(root);
      const manifestPath = await writeManifest(root, {
        url: 'https://example.test/antigravity-1.1.1-darwin-arm64.tar.gz',
        sha256: 'b'.repeat(64),
        size: archive.size,
      });
      const env = {
        CLOUDCLI_ANTIGRAVITY_MANIFEST: manifestPath,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
      } as NodeJS.ProcessEnv;

      await assert.rejects(
        installAntigravityRuntime({
          env,
          platform: 'darwin',
          arch: 'arm64',
          download: copyingDownload(archive.archivePath),
        }),
        (error: Error & { code?: string }) => error.code === 'ANTIGRAVITY_ARTIFACT_CHECKSUM_MISMATCH',
      );
      assert.equal(isAntigravityRuntimeInstalled(VERSION, env), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a size mismatch before hashing', async () => {
    const root = await makeScratchDir('antigravity-badsize-');
    try {
      const archive = await createFakeArchive(root);
      const manifestPath = await writeManifest(root, {
        url: 'https://example.test/antigravity-1.1.1-darwin-arm64.tar.gz',
        sha256: archive.sha256,
        size: archive.size + 1,
      });
      const env = {
        CLOUDCLI_ANTIGRAVITY_MANIFEST: manifestPath,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
      } as NodeJS.ProcessEnv;

      await assert.rejects(
        installAntigravityRuntime({
          env,
          platform: 'darwin',
          arch: 'arm64',
          download: copyingDownload(archive.archivePath),
        }),
        (error: Error & { code?: string }) => error.code === 'ANTIGRAVITY_ARTIFACT_SIZE_MISMATCH',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to install at all when the host has no pin', async () => {
    const root = await makeScratchDir('antigravity-nopin-');
    try {
      const env = { CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime') } as NodeJS.ProcessEnv;
      await assert.rejects(
        installAntigravityRuntime({
          env,
          platform: 'linux',
          arch: 'x64',
          download: async () => assert.fail('must not download without a verified pin'),
        }),
        (error: Error & { code?: string }) => error.code === 'ANTIGRAVITY_RUNTIME_NOT_PINNED',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported host with a platform error, not a download attempt', async () => {
    await assert.rejects(
      installAntigravityRuntime({
        env: {} as NodeJS.ProcessEnv,
        platform: 'darwin',
        arch: 'x64',
        download: async () => assert.fail('must not download for an unsupported host'),
      }),
      (error: Error & { code?: string }) => error.code === 'ANTIGRAVITY_UNSUPPORTED_PLATFORM',
    );
  });

  it('rejects an archive missing the localharness sidecar', async () => {
    const root = await makeScratchDir('antigravity-noharness-');
    try {
      const payloadDir = path.join(root, 'payload');
      await mkdir(payloadDir, { recursive: true });
      await writeFile(path.join(payloadDir, 'agy_acp_server'), '#!/bin/sh\nexit 0\n', 'utf8');
      const archivePath = path.join(root, 'incomplete.tar.gz');
      assert.equal(spawnSync('tar', ['-czf', archivePath, '-C', payloadDir, 'agy_acp_server']).status, 0);

      const manifestPath = await writeManifest(root, {
        url: 'https://example.test/incomplete.tar.gz',
        sha256: await sha256File(archivePath),
        size: (await stat(archivePath)).size,
      });
      const env = {
        CLOUDCLI_ANTIGRAVITY_MANIFEST: manifestPath,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
      } as NodeJS.ProcessEnv;

      await assert.rejects(
        installAntigravityRuntime({
          env,
          platform: 'darwin',
          arch: 'arm64',
          download: copyingDownload(archivePath),
        }),
        (error: Error & { code?: string }) => error.code === 'ANTIGRAVITY_ARCHIVE_MISSING_HARNESS',
      );
      assert.equal(isAntigravityRuntimeInstalled(VERSION, env), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Antigravity runtime paths and spawn args', () => {
  it('honors CLOUDCLI_ANTIGRAVITY_DIR for the install root', () => {
    assert.equal(
      antigravityInstallRoot({ CLOUDCLI_ANTIGRAVITY_DIR: '/tmp/ag' } as NodeJS.ProcessEnv),
      path.resolve('/tmp/ag'),
    );
    assert.equal(
      antigravityInstallRoot({} as NodeJS.ProcessEnv),
      path.join(os.homedir(), '.cloudcli', 'antigravity'),
    );
  });

  it('passes --uid only on Linux and never an acp subcommand', () => {
    assert.deepEqual(antigravityAcpArgs('linux', 501), ['--uid=501']);
    assert.deepEqual(antigravityAcpArgs('darwin', 501), []);
    assert.deepEqual(antigravityAcpArgs('win32', 501), []);
    // A host with no uid (Windows-style Node) must not emit `--uid=undefined`.
    assert.deepEqual(antigravityAcpArgs('linux', undefined), []);
  });

  it('lets an explicit override win and errors instead of falling back to PATH', async () => {
    const root = await makeScratchDir('antigravity-resolve-');
    try {
      const override = path.join(root, 'my_acp_server');
      await writeFile(override, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(override, 0o755);

      const winning = resolveAntigravityBinary({
        ANTIGRAVITY_ACP_PATH: override,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
        PATH: '',
      } as NodeJS.ProcessEnv);
      assert.deepEqual(winning, { ok: true, command: override, source: 'override' });

      const broken = resolveAntigravityBinary({
        ANTIGRAVITY_ACP_PATH: path.join(root, 'missing'),
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
        // A perfectly good agent on PATH must NOT rescue a wrong explicit path.
        PATH: root,
      } as NodeJS.ProcessEnv);
      assert.equal(broken.ok, false);
      assert.equal(broken.ok === false && broken.code, 'INVALID_OVERRIDE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the managed runtime before PATH when no override is set', async () => {
    const root = await makeScratchDir('antigravity-managed-');
    try {
      const archive = await createFakeArchive(root);
      const manifestPath = await writeManifest(root, {
        url: 'https://example.test/antigravity-1.1.1-darwin-arm64.tar.gz',
        sha256: archive.sha256,
        size: archive.size,
      });
      const pathDir = path.join(root, 'onpath');
      await mkdir(pathDir, { recursive: true });
      const pathBinary = path.join(pathDir, 'agy_acp_server');
      await writeFile(pathBinary, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(pathBinary, 0o755);

      const env = {
        CLOUDCLI_ANTIGRAVITY_MANIFEST: manifestPath,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
        PATH: pathDir,
      } as NodeJS.ProcessEnv;

      // Before install, PATH is the only candidate.
      const beforeInstall = resolveAntigravityBinary(env);
      assert.deepEqual(beforeInstall, { ok: true, command: pathBinary, source: 'path' });

      await installAntigravityRuntime({
        env,
        platform: 'darwin',
        arch: 'arm64',
        download: copyingDownload(archive.archivePath),
      });

      const afterInstall = resolveAntigravityBinary(env);
      assert.equal(afterInstall.ok, true);
      assert.equal(afterInstall.ok === true && afterInstall.source, 'managed');
      assert.equal(
        afterInstall.ok === true && afterInstall.command,
        path.join(root, 'runtime', VERSION, 'agy_acp_server'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports NOT_INSTALLED on a supported host with nothing available', async () => {
    const root = await makeScratchDir('antigravity-absent-');
    try {
      const resolution = resolveAntigravityBinary(
        { CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'), PATH: '' } as NodeJS.ProcessEnv,
        { platform: 'linux', arch: 'x64' },
      );
      assert.equal(resolution.ok, false);
      assert.equal(resolution.ok === false && resolution.code, 'NOT_INSTALLED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports UNSUPPORTED_PLATFORM for an Intel Mac rather than NOT_INSTALLED', async () => {
    const root = await makeScratchDir('antigravity-intel-');
    try {
      const resolution = resolveAntigravityBinary(
        { CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'), PATH: '' } as NodeJS.ProcessEnv,
        { platform: 'darwin', arch: 'x64' },
      );
      assert.equal(resolution.ok, false);
      assert.equal(resolution.ok === false && resolution.code, 'UNSUPPORTED_PLATFORM');
      assert.match(resolution.ok === false ? resolution.message : '', /Intel Macs/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Antigravity OAuth URL capture', () => {
  const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F&scope=y';

  it('scrapes the official ACP prefix and rejects marketing pages', () => {
    assert.equal(
      extractOauthUrl(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${consentUrl}`),
      consentUrl,
    );
    assert.equal(
      extractOauthUrl(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(consentUrl)}\n`),
      consentUrl,
    );
    assert.ok(parseAntigravityAuthorizationUrl(consentUrl));
    // A non-consent URL in a log line is not a sign-in link.
    assert.equal(extractOauthUrl('see https://example.com/docs for details'), null);
    assert.equal(extractOauthUrl(''), null);
    assert.equal(
      extractOauthUrl('https://accounts.google.com/AccountChooser?Email=x@gmail.com&continue=https%3A%2F%2Fone.google.com%2Fai'),
      null,
    );
    assert.equal(extractOauthUrl('Open https://antigravity.google/g1-upgrade to continue'), null);
    assert.equal(
      extractOauthUrl(
        `See https://antigravity.google/g1-upgrade\n${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${consentUrl}`,
      ),
      consentUrl,
    );
    // Incomplete oauth URLs (no loopback redirect_uri) must not count as consent.
    assert.equal(
      extractOauthUrl('Visit https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=y to continue.'),
      null,
    );
  });

  it('forces a private GEMINI_HOME and strips host Google API keys', async () => {
    const root = await makeScratchDir('antigravity-profile-');
    try {
      const env = {
        CLOUDCLI_ANTIGRAVITY_DIR: root,
        GEMINI_API_KEY: 'secret-gemini',
        GOOGLE_API_KEY: 'secret-google',
        PATH: '/usr/bin',
        HOME: process.env.HOME,
      } as NodeJS.ProcessEnv;
      const launch = buildAntigravityLaunchEnv(env);
      assert.equal(launch.GEMINI_API_KEY, undefined);
      assert.equal(launch.GOOGLE_API_KEY, undefined);
      assert.equal(launch.AGY_ACP_FORCE_FILE_STORAGE, '1');
      assert.match(launch.GEMINI_HOME ?? '', /profile$/);
      assert.match(launch.BROWSER ?? '', /CLOUDCLI_ANTIGRAVITY_AUTH_URL|execPath|-e/);
      assert.equal(fs.existsSync(path.join(launch.GEMINI_HOME ?? '', 'antigravity-acp', 'settings.json')), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts only loopback return URLs for the pasted callback', () => {
    assert.equal(isLoopbackReturnUrl('http://127.0.0.1:44321/?code=abc'), true);
    assert.equal(isLoopbackReturnUrl('http://localhost:44321/?code=abc'), true);
    // Replaying an arbitrary URL would turn the callback into a request
    // forwarder, so anything non-loopback is refused.
    assert.equal(isLoopbackReturnUrl('https://evil.example/?code=abc'), false);
    assert.equal(isLoopbackReturnUrl('file:///etc/passwd'), false);
    assert.equal(isLoopbackReturnUrl('not a url'), false);
  });
});

/**
 * A stand-in for agy_acp_server that behaves like 1.1.1 does: `initialize`
 * always lists every auth method, and `authenticate` either resolves `{}`
 * (token file present) or prints the consent URL and blocks (no token).
 */
async function writeFakeAcpServer(root: string): Promise<string> {
  const script = path.join(root, 'fake-agy.mjs');
  await writeFile(script, `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const tokenPath = path.join(process.env.GEMINI_HOME, 'antigravity-acp', 'acp_token.json');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { auth: { logout: {} } },
      authMethods: [
        { id: 'oauth-personal', name: 'Log in with Google' },
        { id: 'oauth-business' }, { id: 'gemini-api-key' }, { id: 'agent-platform' },
      ],
    } }) + '\\n');
  } else if (msg.method === 'authenticate') {
    if (fs.existsSync(tokenPath)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else {
      process.stderr.write('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A49695%2F&scope=y&state=abc\\n');
    }
  }
});
`, 'utf8');
  const wrapper = path.join(root, 'agy_acp_server');
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  await chmod(wrapper, 0o755);
  return wrapper;
}

describe('Antigravity sign-in probe', () => {
  it('does not trust authMethods and only reports signed in when authenticate succeeds', async () => {
    const root = await makeScratchDir('antigravity-signin-');
    try {
      const binary = await writeFakeAcpServer(root);
      const env = {
        ...process.env,
        ANTIGRAVITY_ACP_PATH: binary,
        CLOUDCLI_ANTIGRAVITY_DIR: path.join(root, 'runtime'),
      } as NodeJS.ProcessEnv;

      // 1.1.1 lists every method regardless of state, so this alone is meaningless.
      const initialize = await probeAntigravityAcp(env, 10_000);
      assert.equal(initialize.authMethods.length, 4);

      // No token on disk: skipped authenticate, not signed in.
      const before = await probeAntigravitySignIn(env, 'oauth-personal', 10_000);
      assert.equal(before.authenticated, false);
      assert.equal(before.reason, 'no-token');

      // A token that the agent rejects surfaces as a consent request.
      const tokenPath = path.join(root, 'runtime', 'profile', 'antigravity-acp', 'acp_token.json');
      await mkdir(path.dirname(tokenPath), { recursive: true });
      await writeFile(tokenPath, '{"refresh_token":"x"}', 'utf8');
      const fakeScript = path.join(root, 'fake-agy.mjs');
      const original = await readFile(fakeScript, 'utf8');
      await writeFile(fakeScript, original.replace('fs.existsSync(tokenPath)', 'false'), 'utf8');
      const rejected = await probeAntigravitySignIn(env, 'oauth-personal', 10_000);
      assert.equal(rejected.authenticated, false);
      assert.equal(rejected.reason, 'consent-required');

      // A working token: authenticate resolves, signed in.
      await writeFile(fakeScript, original, 'utf8');
      const after = await probeAntigravitySignIn(env, 'oauth-personal', 10_000);
      assert.equal(after.authenticated, true);
      assert.equal(after.reason, 'authenticated');
      assert.equal(after.initialize.authMethods.length, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caches getStatus() result to avoid repeated child process spawns', async () => {
    resetAntigravityAuthCacheForTests();
    const auth = new AntigravityProviderAuth();
    const status1 = await auth.getStatus();
    const status2 = await auth.getStatus();
    assert.equal(status1, status2);
    resetAntigravityAuthCacheForTests();
  });
});

describe('Antigravity models', () => {
  it('reads the catalog from the ACP model config option and invents nothing', () => {
    const catalog = parseAntigravityModelCatalog({
      sessionId: 's1',
      configOptions: [
        { id: 'mode', options: [{ value: 'default' }, { value: 'yolo' }] },
        {
          id: 'model',
          value: 'model-b',
          options: [
            { value: 'model-a', name: 'Model A' },
            { value: 'model-b', name: 'Model B', description: 'the current one' },
          ],
        },
      ],
    });
    assert.deepEqual(catalog.OPTIONS.map((option) => option.value), ['model-a', 'model-b']);
    assert.equal(catalog.OPTIONS[1].description, 'the current one');
    assert.equal(catalog.DEFAULT, 'model-b');

    // 1.1.1 reports the selected model as `currentValue`, not `value`; missing
    // that would default the picker to whatever option happens to be first.
    const current = parseAntigravityModelCatalog({
      configOptions: [
        {
          id: 'model',
          currentValue: 'gemini-3.7-flash-high',
          options: [
            { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
            { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
          ],
        },
      ],
    });
    assert.equal(current.DEFAULT, 'gemini-3.7-flash-high');

    // No model option (or no session) must yield an empty catalog, never a
    // guessed Gemini model list.
    assert.deepEqual(parseAntigravityModelCatalog({ configOptions: [] }), { OPTIONS: [], DEFAULT: '' });
    assert.deepEqual(parseAntigravityModelCatalog(null), { OPTIONS: [], DEFAULT: '' });
  });
});

describe('Antigravity skills discovery', () => {
  it('prefers .gemini, then .agents, then .agent, project before user', async () => {
    const provider = new AntigravitySkillsProvider();
    const sources = await (provider as unknown as {
      getSkillSources: (workspacePath: string) => Promise<{ scope: string; rootDir: string }[]>;
    }).getSkillSources('/workspace/demo');

    assert.deepEqual(sources.map((source) => source.rootDir), [
      path.join('/workspace/demo', '.gemini', 'skills'),
      path.join('/workspace/demo', '.agents', 'skills'),
      path.join('/workspace/demo', '.agent', 'skills'),
      path.join(os.homedir(), '.gemini', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
      path.join(os.homedir(), '.agent', 'skills'),
    ]);
    assert.deepEqual(sources.map((source) => source.scope), [
      'project', 'project', 'project', 'user', 'user', 'user',
    ]);
  });
});

describe('Antigravity sessions', () => {
  it('normalizes ACP update shapes and reports no readable history', async () => {
    const provider = new AntigravitySessionsProvider();
    assert.equal(
      provider.normalizeMessage({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } }, 's1')[0]?.kind,
      'stream_delta',
    );
    assert.equal(
      provider.normalizeMessage({ sessionUpdate: 'agent_thought_chunk', content: { text: 'thinking' } }, 's1')[0]?.kind,
      'thinking',
    );
    assert.equal(
      provider.normalizeMessage({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', rawInput: { command: 'ls' } }, 's1')[0]?.kind,
      'tool_use',
    );
    const result = provider.normalizeMessage(
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', rawOutput: 'boom' },
      's1',
    )[0];
    assert.equal(result?.kind, 'tool_result');
    assert.equal(result?.isError, true);
    assert.deepEqual(provider.normalizeMessage({ sessionUpdate: 'unknown_thing' }, 's1'), []);

    // `session/load` is addressed with a cwd; without one there is nothing to
    // replay, so the reader returns an honest empty page instead of guessing.
    assert.deepEqual(await provider.fetchHistory('s1'), {
      messages: [], total: 0, hasMore: false, offset: 0, limit: null,
    });
  });

  it('reads Antigravity\'s object-shaped tool output instead of blanking the result', () => {
    const provider = new AntigravitySessionsProvider();
    // The shell tool sends an object, not a string; reading only the string
    // case rendered every completed tool call as an empty (red) result.
    const shell = provider.normalizeMessage({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { commandLine: 'ls', exitCode: 0, combinedOutput: 'a\nb\n', formatted_output: 'a\nb\n' },
    }, 's1')[0];
    assert.equal(shell?.content, 'a\nb\n');
    assert.equal(shell?.isError, false);

    // Anything without a known text field still has to say something.
    const opaque = provider.normalizeMessage({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      rawOutput: { unexpected: 42 },
    }, 's1')[0];
    assert.match(String(opaque?.content), /"unexpected": 42/);
  });

  it('detaches a denial that names a path its tool call never asked for', () => {
    const provider = new AntigravitySessionsProvider();
    // Antigravity 1.1.1 reports a LATER call's sandbox denial under an EARLIER
    // call's toolCallId (reproduced against a bare ACP client). Attaching it
    // verbatim paints an innocent call red with someone else's error, which is
    // what turned a handful of real denials into a transcript full of failures.
    const misattributed = provider.normalizeMessage({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
      [ANTIGRAVITY_ANNOUNCED_PATH_KEY]: '/repo/package.json',
      rawOutput: 'Access to path "/home/me/.codex/config.toml" is denied. It is outside the allowed workspace directories: [/repo]',
    }, 's1')[0];
    // Still an error the user must see — just not pinned to the wrong call.
    assert.equal(misattributed?.isError, true);
    assert.equal(misattributed?.toolId, '');

    // A denial about the call's OWN path stays attached to it.
    const genuine = provider.normalizeMessage({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'failed',
      [ANTIGRAVITY_ANNOUNCED_PATH_KEY]: '/home/me/.codex/config.toml',
      rawOutput: 'Access to path "/home/me/.codex/config.toml" is denied. It is outside the allowed workspace directories: [/repo]',
    }, 's1')[0];
    assert.equal(genuine?.toolId, 't2');

    // A failure that is not a sandbox denial is never second-guessed.
    const other = provider.normalizeMessage({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't3',
      status: 'failed',
      [ANTIGRAVITY_ANNOUNCED_PATH_KEY]: '/repo/package.json',
      rawOutput: 'Failure in MCP tool execution: Provide between 1 and 20 relay tasks.',
    }, 's1')[0];
    assert.equal(other?.toolId, 't3');
  });

  it('reads the announced path from ACP locations or either argument casing', () => {
    assert.equal(
      antigravityAnnouncedToolPath({ locations: [{ path: '/repo/a.ts' }], rawInput: '{"AbsolutePath":"/other"}' }),
      '/repo/a.ts',
    );
    // Builtin-tool arguments arrive as a JSON *string*, MCP-tool ones as an object.
    assert.equal(antigravityAnnouncedToolPath({ rawInput: '{"AbsolutePath":"/repo/a.ts"}' }), '/repo/a.ts');
    assert.equal(antigravityAnnouncedToolPath({ rawInput: { absolute_path: '/repo/a.ts' } }), '/repo/a.ts');
    assert.equal(antigravityAnnouncedToolPath({ rawInput: 'not json' }), '');
    assert.equal(antigravityAnnouncedToolPath(null), '');

    // A workspace-relative announcement still matches its absolute denial.
    assert.equal(isMisattributedDenial('package.json', '/repo/package.json'), false);
    assert.equal(isMisattributedDenial('package.json', '/repo/other.json'), true);
    assert.equal(isMisattributedDenial('', '/repo/a'), false);
  });

  it('keeps CloudCLI prompt plumbing out of titles and replayed user turns', () => {
    // Antigravity concatenates every text block of a session/prompt into ONE
    // stored user message, so a separate content block does not keep the
    // sandbox briefing out of the transcript — it has to be stripped on read.
    assert.equal(
      antigravityTitleFromPrompt('<workspace_boundary>Your view_file is scoped…</workspace_boundary>\n\nFix the toggle UI'),
      'Fix the toggle UI',
    );
    assert.equal(
      antigravityTitleFromPrompt('Fix the toggle UI\n\n<images_input>\n1. /a/b.png\n</images_input>'),
      'Fix the toggle UI',
    );

    const provider = new AntigravitySessionsProvider();
    const messages = (provider as unknown as {
      normalizeHistoryUpdates: (updates: Record<string, unknown>[], sessionId: string) => NormalizedMessage[];
    }).normalizeHistoryUpdates([
      { sessionUpdate: 'user_message_chunk', content: { text: '<workspace_boundary>note</workspace_boundary> ' } },
      { sessionUpdate: 'user_message_chunk', content: { text: 'Fix the toggle UI' } },
    ], 's1');
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, 'Fix the toggle UI');
  });

  it('collapses a replayed chunk stream into whole messages', () => {
    const provider = new AntigravitySessionsProvider();
    // `session/load` replays chunk-granular updates; emitting them verbatim
    // would render one paragraph as many single-word bubbles.
    const messages = (provider as unknown as {
      normalizeHistoryUpdates: (updates: Record<string, unknown>[], sessionId: string) => NormalizedMessage[];
    }).normalizeHistoryUpdates([
      { sessionUpdate: 'user_message_chunk', content: { text: 'hi ' } },
      { sessionUpdate: 'user_message_chunk', content: { text: 'there' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 'one ' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 'two' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', rawInput: { command: 'ls' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 'after' } },
    ], 's1');

    assert.deepEqual(
      messages.map((message) => [message.kind, message.role ?? null, message.content ?? null]),
      [
        ['text', 'user', 'hi there'],
        ['thinking', null, 'hmm'],
        ['text', 'assistant', 'one two'],
        ['tool_use', null, null],
        ['text', 'assistant', 'after'],
      ],
    );
  });
});
