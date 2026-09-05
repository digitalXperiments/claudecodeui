/**
 * Quota readout for Antigravity, via the `agy` CLI's `/usage` command.
 *
 * The managed `agy_acp_server` runtime CloudCLI drives for chat exposes no
 * quota at all — its `retrieveUserQuota[Summary]` endpoints answer
 * `403 SUBSCRIPTION_REQUIRED` for personal Google accounts. The `agy` CLI is a
 * *different* binary with a different backend path, and it does have one:
 *
 *   agy --output-format json -p=/usage
 *
 * That resolves the slash command locally and returns the real buckets without
 * running a model turn (`num_turns: 0`, `total_tokens: 0`), so polling it costs
 * the user nothing.
 *
 * ## Payload
 *
 * `command.data.groups[]` — one per model family that shares a limit
 * ("Gemini Models", "Claude and GPT models"), each with `buckets[]`:
 *
 *   { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly",
 *     remaining_fraction: 0.857, reset_time: "2026-09-11T01:22:24Z" }
 *
 * Only a *fraction* is published — never an absolute cap — because quota is
 * consumed proportionally to token cost rather than counted in requests. So the
 * windows below are percent-unit, and the absolute `limit`/`remaining` numbers
 * stay derived from that fraction rather than invented.
 *
 * ## Account caveat
 *
 * `agy` signs in under `~/.gemini/antigravity-cli/`, while CloudCLI's ACP
 * runtime uses its own private profile under `~/.cloudcli/antigravity/`. They
 * are normally the same Google account, but they are not the same credential
 * store: if `agy` is signed out, this reports unavailable rather than guessing,
 * and if the two are signed in as different users the meter shows the `agy`
 * account's quota.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

/**
 * `/usage` is answered locally, but the CLI still boots its harness and
 * refreshes an OAuth token first, which is the slow part.
 */
export const AGY_USAGE_TIMEOUT_MS = 60_000;

/** stdout is one JSON object; this only guards against a runaway binary. */
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Where the `agy` CLI installs itself, in priority order relative to `$HOME`.
 *
 * A GUI-launched CloudCLI (the Electron app, or the LaunchAgent) inherits
 * launchd's minimal PATH, which contains none of these — so resolving `agy`
 * through PATH alone reports "not installed" on exactly the machines where the
 * user's terminal finds it fine. Same failure mode, same fix as
 * `shared/claude-cli-path.ts`.
 */
const AGY_HOME_CANDIDATES = [
  ['.local', 'bin', 'agy'],
  ['.antigravity', 'bin', 'agy'],
] as const;

const AGY_SYSTEM_CANDIDATES = [
  '/opt/homebrew/bin/agy',
  '/usr/local/bin/agy',
  '/usr/bin/agy',
] as const;

const isExecutableFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK), true);
  } catch {
    return false;
  }
};

/**
 * Absolute path to the `agy` CLI, or `'agy'` to let PATH resolve it.
 *
 * `CLOUDCLI_AGY_PATH` wins so a container or CI host can point at a custom
 * install without a config file.
 */
export function resolveAgyCliCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLOUDCLI_AGY_PATH?.trim();
  if (override) return override;

  const home = env.HOME?.trim() || os.homedir();
  for (const segments of AGY_HOME_CANDIDATES) {
    const candidate = path.join(home, ...segments);
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const candidate of AGY_SYSTEM_CANDIDATES) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return 'agy';
}

export type AgyUsageBucket = {
  id: string;
  name: string;
  /** `"weekly"`, `"5h"`, … — passed through rather than enumerated. */
  window: string;
  description: string | null;
  /** 0–1. `null` when the CLI omitted or malformed it. */
  remainingFraction: number | null;
  resetTime: string | null;
};

export type AgyUsageGroup = {
  name: string;
  description: string | null;
  buckets: AgyUsageBucket[];
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const readString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

/**
 * Extract the usage groups from an `agy --output-format json` envelope.
 *
 * Exported for tests, and separate from the spawn so a CLI release that changes
 * its envelope can be diagnosed against a captured payload.
 */
export function parseAgyUsagePayload(payload: unknown): AgyUsageGroup[] {
  const command = asRecord(asRecord(payload)?.command);
  // Both `/usage` and `/quota` resolve to the same command; check the name so a
  // payload from some other command is not mined for quota-shaped fields.
  if (readString(command?.name) !== 'usage') return [];

  const groups = asRecord(command?.data)?.groups;
  if (!Array.isArray(groups)) return [];

  return groups.flatMap((rawGroup) => {
    const group = asRecord(rawGroup);
    const name = readString(group?.name);
    if (!name) return [];

    const rawBuckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const buckets = rawBuckets.flatMap((rawBucket) => {
      const bucket = asRecord(rawBucket);
      const id = readString(bucket?.id);
      if (!id) return [];
      const fraction = bucket?.remaining_fraction;
      return [{
        id,
        name: readString(bucket?.name) ?? id,
        window: readString(bucket?.window) ?? '',
        description: readString(bucket?.description),
        remainingFraction: typeof fraction === 'number' && Number.isFinite(fraction)
          ? Math.min(1, Math.max(0, fraction))
          : null,
        resetTime: readString(bucket?.reset_time),
      } satisfies AgyUsageBucket];
    });

    return buckets.length ? [{ name, description: readString(group?.description), buckets }] : [];
  });
}

/**
 * Pick the JSON envelope out of the CLI's stdout.
 *
 * The CLI prefixes advisory lines (update notices, permission warnings) before
 * the payload, so this scans backwards for the last parseable object rather
 * than assuming stdout is pure JSON.
 */
export function readAgyJsonEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const parsed = asRecord(JSON.parse(lines[i]));
      if (parsed) return parsed;
    } catch {
      // Not the payload line; keep scanning backwards.
    }
  }
  return null;
}

export type AgyUsageRunResult = { stdout: string; stderr: string; code: number | null };

/** Exported so the adapter's tests can drive the parser without a real CLI. */
export async function runAgyUsageCommand(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = AGY_USAGE_TIMEOUT_MS,
): Promise<AgyUsageRunResult> {
  return new Promise((resolve, reject) => {
    // `-p=` attached form is required: `agy` otherwise consumes the following
    // flag as the prompt and errors out.
    const child = spawn(resolveAgyCliCommand(env), ['--output-format', 'json', '-p=/usage'], {
      // The home directory, not the server's cwd: `/usage` needs no workspace,
      // and starting in a project would make the CLI adopt it as one.
      cwd: env.HOME?.trim() || os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
        reject(new Error(`Antigravity usage command timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on('error', (error: Error) => finish(() => reject(error)));
    child.on('close', (code: number | null) => finish(() => resolve({ stdout, stderr, code })));
  });
}

/**
 * Read the live quota buckets from the `agy` CLI.
 *
 * Throws with the CLI's own message when it is missing or signed out — the
 * caller turns that into an "unavailable" row rather than a fabricated meter.
 */
export async function readAgyUsageGroups(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof runAgyUsageCommand = runAgyUsageCommand,
): Promise<AgyUsageGroup[]> {
  let result: AgyUsageRunResult;
  try {
    result = await run(env, AGY_USAGE_TIMEOUT_MS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('The agy CLI is not installed, so Antigravity usage cannot be read.');
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  const envelope = readAgyJsonEnvelope(result.stdout);
  const groups = envelope ? parseAgyUsagePayload(envelope) : [];
  if (groups.length) return groups;

  // No groups means the CLI ran but could not answer. Its own wording ("You are
  // not logged into Antigravity.") is more useful than anything invented here,
  // and the service's auth classifier keys off phrases like it.
  const detail = readString(envelope?.response)
    ?? result.stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop()
    ?? `agy exited with code ${result.code}`;
  throw new Error(`Antigravity usage is unavailable: ${detail}`);
}
