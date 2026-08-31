import os from 'node:os';
import path from 'node:path';

/**
 * Oh My Pi keeps each profile under `~/.omp/<profile>` (the default profile is
 * `agent`). `PI_CODING_AGENT_DIR` is the CLI's documented explicit state-dir
 * override. `OMP_HOME` is intentionally ignored: v18 does not document it and
 * treating it as authoritative made CloudCLI inspect a different tree than OMP.
 */
export function ompProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const requestedProfile = env.OMP_PROFILE?.trim();
  const profile = requestedProfile && path.basename(requestedProfile) === requestedProfile
    ? requestedProfile
    : 'agent';
  return path.join(os.homedir(), '.omp', profile);
}

export const ompSessionsRoot = (): string => path.join(ompProfileDir(), 'sessions');

export const ompAuthPath = (): string => path.join(ompProfileDir(), 'auth.json');

export const ompCredentialDbPath = (): string => path.join(ompProfileDir(), 'agent.db');

export const ompSkillsRoot = (): string => path.join(ompProfileDir(), 'skills');
