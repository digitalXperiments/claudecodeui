import express from 'express';

import {
  getAppFeatures,
  updateAppFeatures,
} from '@/modules/app-features/app-features.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new AppError('kanbanEnabled must be a boolean', {
    code: 'FEATURES_INVALID',
    statusCode: 400,
  });
}

function readOptionalCost(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === 'off' || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(`${field} must be a positive number or null`, {
      code: 'FEATURES_INVALID',
      statusCode: 400,
    });
  }
  return parsed;
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ features: getAppFeatures() });
  }),
);

router.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const features = updateAppFeatures({
      kanbanEnabled: readOptionalBoolean(body.kanbanEnabled),
      spendSoftCostUsd: readOptionalCost(body.spendSoftCostUsd, 'spendSoftCostUsd'),
      spendHardCostUsd: readOptionalCost(body.spendHardCostUsd, 'spendHardCostUsd'),
    });
    res.json({ features });
  }),
);

export default router;
