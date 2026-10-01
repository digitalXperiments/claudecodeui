import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Root of all bot homes: `$CLOUDCLI_BOTS_HOME` or `~/.cloudcli/bots`.
 * Under `node --test` (NODE_TEST_CONTEXT is set for test files) with no override, homes go to
 * a temp folder instead, so a test that forgets to isolate can never write into the operator's
 * real bots folder.
 */
export function resolveBotsRoot(): string {
  const override = process.env.CLOUDCLI_BOTS_HOME?.trim();
  if (override) return path.resolve(override);
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), 'cloudcli-test-bots');
  return path.join(os.homedir(), '.cloudcli', 'bots');
}

/** Subfolders every bot home starts with. `browser-profile/` is created lazily by the browser. */
export const BOT_HOME_DIRS = ['skills', 'spaces', 'scratch'] as const;

/** Persistent browser profile directory name inside a bot home. */
export const BOT_BROWSER_PROFILE_DIRNAME = 'browser-profile';

const README_TEXT = `# Bot home

This folder belongs to one CloudCLI bot. It is the bot's working directory when the bot is not
attached to a project, and it survives between wake-ups. It lives outside Documents, Desktop and
Downloads on purpose (macOS privacy prompts would block a background server there).

- \`skills/\`   SKILL.md playbooks this bot has learned or been taught. Managed from Bot Studio.
- \`spaces/\`   Living documents the bot owns and keeps up to date (notes, reports).
- \`scratch/\`  Throwaway files for the current job. Safe to delete at any time.
- \`browser-profile/\`  The bot's own browser logins and cookies, kept between runs. Created the first
  time the bot opens a browser. Delete it to sign the bot out of every site.

Everything here is the bot's own. Do not put secrets in these files; use the CloudCLI secrets vault.
`;

function seedHome(home: string): void {
  for (const dir of BOT_HOME_DIRS) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const readme = path.join(home, 'README.md');
  // `wx` never overwrites an operator-edited README, even if two callers race on a new home.
  try {
    fs.writeFileSync(readme, README_TEXT, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * `<root>/<bot_id>/home`, created on demand. A newly created home is seeded with a README and the
 * standard subfolders (an existing home is left exactly as it is). Rejects ids that could escape
 * the root.
 */
export function resolveBotHome(botId: string, options: { create?: boolean } = {}): string {
  if (!botId || botId !== path.basename(botId) || botId === '.' || botId === '..') {
    throw new Error(`Invalid bot id for home directory: ${JSON.stringify(botId)}`);
  }
  const home = path.join(resolveBotsRoot(), botId, 'home');
  if (options.create !== false) {
    const isNew = !fs.existsSync(home);
    fs.mkdirSync(home, { recursive: true });
    if (isNew) seedHome(home);
  }
  return home;
}

/** `<botHome>/browser-profile` (the directory is created by the browser, not here). */
export function resolveBotBrowserProfileDir(botId: string): string {
  return path.join(resolveBotHome(botId), BOT_BROWSER_PROFILE_DIRNAME);
}
