import express, { type Request, type Response } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import { getProviderUsage } from './provider-usage.service.js';
import type { ProviderUsageRefreshReason } from './provider-usage.types.js';

const router = express.Router();

const isTruthyQuery = (value: unknown): boolean => value === '1' || value === 'true';

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const fresh = isTruthyQuery(req.query.fresh);
    const authChange = isTruthyQuery(req.query.authChange) || req.query.reason === 'auth-change';
    const reason: ProviderUsageRefreshReason = authChange
      ? 'auth-change'
      : fresh
        ? 'manual'
        : 'poll';
    const payload = await getProviderUsage({
      fresh: fresh || authChange,
      reason,
    });

    // The server owns the cache. Avoid browser/proxy caching an aggregate that
    // can outlive the five-minute server TTL or contain a stale auth membership.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(payload);
  }),
);

export default router;
