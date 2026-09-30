/**
 * Host facts for always-on deployments: is the machine allowed to sleep, is a public URL set
 * (signed approval links need one when you are away from the machine), how long has the server run.
 * See docs/prd/bot-runtime/HEADLESS.md.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';

import { appConfigDb } from '@/modules/database/index.js';

import { PUBLIC_BASE_URL_CONFIG } from '../channels/signed-links.js';

export interface HostInfo {
  platform: NodeJS.Platform;
  /**
   * True when something is holding the Mac awake (`caffeinate`, an app, or a power setting that
   * shows up as an assertion). False when nothing is. Null when it cannot be determined (not macOS,
   * or `pmset` failed): treat null as unknown, not as awake.
   */
  sleepPrevented: boolean | null;
  publicUrlConfigured: boolean;
  /** Seconds this server process has been running. */
  uptime: number;
  /** Seconds since the host booted. */
  hostUptime: number;
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 4_000, maxBuffer: 256 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/**
 * Reads the two assertions that stop idle/system sleep out of `pmset -g assertions`:
 *
 *     PreventUserIdleSystemSleep     1
 *     PreventSystemSleep             0
 *
 * Returns null when neither line is present (unrecognised output).
 */
export function parsePmsetAssertions(output: string): boolean | null {
  let seen = false;
  let prevented = false;
  for (const line of output.split('\n')) {
    const match = /^\s*(PreventUserIdleSystemSleep|PreventSystemSleep)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    seen = true;
    if (Number(match[2]) > 0) prevented = true;
  }
  return seen ? prevented : null;
}

export interface HostInfoOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Overrides the configured-URL check (tests). */
  publicUrl?: string | null;
}

function publicUrlConfigured(override?: string | null): boolean {
  if (override !== undefined) return Boolean(override && override.trim());
  try {
    if (String(appConfigDb.get(PUBLIC_BASE_URL_CONFIG) ?? '').trim()) return true;
  } catch {
    // no database yet: fall through to the env var
  }
  return Boolean(process.env.CLOUDCLI_PUBLIC_URL?.trim());
}

export async function readHostInfo(options: HostInfoOptions = {}): Promise<HostInfo> {
  const platform = options.platform ?? process.platform;
  let sleepPrevented: boolean | null = null;
  if (platform === 'darwin') {
    try {
      sleepPrevented = parsePmsetAssertions(await (options.run ?? defaultRunner)('pmset', ['-g', 'assertions']));
    } catch {
      sleepPrevented = null;
    }
  }
  return {
    platform,
    sleepPrevented,
    publicUrlConfigured: publicUrlConfigured(options.publicUrl),
    uptime: Math.round(process.uptime()),
    hostUptime: Math.round(os.uptime()),
  };
}
