/**
 * Persistent product flags and spend governor settings (app_config).
 *
 * Kanban is a real surface for some installs and unused on this one — the
 * admin toggle hides the rail, panel, and MC → board bridge.
 */

import { appConfigDb } from '@/modules/database/index.js';

export const KANBAN_ENABLED_KEY = 'feature.kanban_enabled';
export const SPEND_SOFT_USD_KEY = 'spend.soft_cost_usd';
export const SPEND_HARD_USD_KEY = 'spend.hard_cost_usd';

export const DEFAULT_SOFT_COST_USD = 80;
export const DEFAULT_HARD_COST_USD = 250;

export type AppFeatures = {
  kanbanEnabled: boolean;
  spendSoftCostUsd: number | null;
  spendHardCostUsd: number | null;
};

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = appConfigDb.get(key);
  if (raw === null) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function readPositiveNumber(key: string, fallback: number | null): number | null {
  const raw = appConfigDb.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  if (raw === 'off' || raw === 'none') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getAppFeatures(): AppFeatures {
  return {
    kanbanEnabled: readBoolean(KANBAN_ENABLED_KEY, true),
    spendSoftCostUsd: readPositiveNumber(SPEND_SOFT_USD_KEY, DEFAULT_SOFT_COST_USD),
    spendHardCostUsd: readPositiveNumber(SPEND_HARD_USD_KEY, DEFAULT_HARD_COST_USD),
  };
}

export function isKanbanEnabled(): boolean {
  return getAppFeatures().kanbanEnabled;
}

export type AppFeaturesPatch = {
  kanbanEnabled?: boolean;
  spendSoftCostUsd?: number | null;
  spendHardCostUsd?: number | null;
};

export function updateAppFeatures(patch: AppFeaturesPatch): AppFeatures {
  if (patch.kanbanEnabled !== undefined) {
    appConfigDb.set(KANBAN_ENABLED_KEY, patch.kanbanEnabled ? 'true' : 'false');
  }
  if (patch.spendSoftCostUsd !== undefined) {
    appConfigDb.set(
      SPEND_SOFT_USD_KEY,
      patch.spendSoftCostUsd == null ? 'off' : String(patch.spendSoftCostUsd),
    );
  }
  if (patch.spendHardCostUsd !== undefined) {
    appConfigDb.set(
      SPEND_HARD_USD_KEY,
      patch.spendHardCostUsd == null ? 'off' : String(patch.spendHardCostUsd),
    );
  }
  return getAppFeatures();
}
