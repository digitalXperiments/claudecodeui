import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of all bot homes: `$CLOUDCLI_BOTS_HOME` or `~/.cloudcli/bots`. */
export function resolveBotsRoot(): string {
  const override = process.env.CLOUDCLI_BOTS_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.cloudcli', 'bots');
}

/** `<root>/<bot_id>/home`, created on demand. Rejects ids that could escape the root. */
export function resolveBotHome(botId: string, options: { create?: boolean } = {}): string {
  if (!botId || botId !== path.basename(botId) || botId === '.' || botId === '..') {
    throw new Error(`Invalid bot id for home directory: ${JSON.stringify(botId)}`);
  }
  const home = path.join(resolveBotsRoot(), botId, 'home');
  if (options.create !== false) fs.mkdirSync(home, { recursive: true });
  return home;
}
