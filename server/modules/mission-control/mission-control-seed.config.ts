import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * User-owned board config for the optional Trello Tasks seed section. This
 * file intentionally lives outside the repo (`~/.cloudcli/...`) — it is
 * personal/client data (board ids, client names, local paths) and must never
 * be hardcoded in source that gets committed or pushed.
 */
export interface TrelloSeedBoardConfig {
  boardName: string;
  boardShortLink: string;
  boardUrl: string;
  boardId: string;
  priorityListName: string;
  priorityListId: string;
  /** Client label used to tag cards that don't already carry a client prefix. */
  client: string;
  /** Example path shown to the model for suggestedProjectPath; illustrative only. */
  suggestedProjectPathExample?: string;
  kanbanMcpTools?: string[];
}

export function getTrelloSeedConfigPath(): string {
  return process.env.CLOUDCLI_TRELLO_SEED_CONFIG_PATH
    || path.join(os.homedir(), '.cloudcli', 'mission-control', 'trello-seed.json');
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function isTrelloSeedBoardConfig(value: unknown): value is TrelloSeedBoardConfig {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.boardName)
    && isNonEmptyString(record.boardShortLink)
    && isNonEmptyString(record.boardUrl)
    && isNonEmptyString(record.boardId)
    && isNonEmptyString(record.priorityListName)
    && isNonEmptyString(record.priorityListId)
    && isNonEmptyString(record.client)
    && (record.suggestedProjectPathExample === undefined || typeof record.suggestedProjectPathExample === 'string')
    && (record.kanbanMcpTools === undefined || Array.isArray(record.kanbanMcpTools))
  );
}

/**
 * Loads the optional Trello seed board config from disk. Returns `null` when
 * the file is absent or malformed so seeding is a no-op for anyone who
 * hasn't opted in — this must never fall back to baked-in defaults.
 */
export function loadTrelloSeedConfig(): TrelloSeedBoardConfig | null {
  const configPath = getTrelloSeedConfigPath();
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return isTrelloSeedBoardConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
