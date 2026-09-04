import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import {
  extractOauthUrl,
  isLoopbackReturnUrl,
} from '@/modules/providers/list/antigravity/antigravity-acp.js';
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
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { AntigravitySkillsProvider } from '@/modules/providers/list/antigravity/antigravity-skills.provider.js';

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
  it('scrapes the consent URL out of noisy agent output', () => {
    assert.equal(
      extractOauthUrl('Visit https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=y to continue.'),
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=y',
    );
    // Trailing punctuation and ANSI colour resets must not join the link.
    assert.equal(
      extractOauthUrl('[36mhttps://accounts.google.com/signin/oauth?code=1[0m.'),
      'https://accounts.google.com/signin/oauth?code=1',
    );
    // A non-consent URL in a log line is not a sign-in link.
    assert.equal(extractOauthUrl('see https://example.com/docs for details'), null);
    assert.equal(extractOauthUrl(''), null);
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

    // Antigravity keeps no CloudCLI-readable transcript store, and it has no
    // rewind capability — history is an honest empty page.
    assert.deepEqual(await provider.fetchHistory('s1'), {
      messages: [], total: 0, hasMore: false, offset: 0, limit: null,
    });
  });
});
