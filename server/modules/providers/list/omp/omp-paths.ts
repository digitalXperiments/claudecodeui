import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Oh My Pi keeps its state under `~/.omp` (overridable with `OMP_HOME`) — never
 * under Pi's `~/.pi`, which belongs to the separate `pi` provider.
 *
 * Oh My Pi is a Pi fork, so it may nest that state under an `agent/` directory
 * the way Pi does, or keep it at the home root. Probe for whichever exists and
 * fall back to the nested layout so a fresh install still resolves.
 */
export function ompHome(): string {
  const configured = process.env.OMP_HOME;
  return configured && configured.trim()
    ? configured.trim()
    : path.join(os.homedir(), '.omp');
}

function resolveStateEntry(...segments: string[]): string {
  const home = ompHome();
  const nested = path.join(home, 'agent', ...segments);
  if (fsSync.existsSync(nested)) {
    return nested;
  }
  const flat = path.join(home, ...segments);
  return fsSync.existsSync(flat) ? flat : nested;
}

export const ompSessionsRoot = (): string => resolveStateEntry('sessions');

export const ompAuthPath = (): string => resolveStateEntry('auth.json');

export const ompSkillsRoot = (): string => resolveStateEntry('skills');
