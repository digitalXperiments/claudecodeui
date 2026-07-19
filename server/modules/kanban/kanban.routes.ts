import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

const router = express.Router();

/**
 * Liveness probe for the Kanban module. Phase 0 skeleton — the real board/task
 * CRUD lands in Phase 1.
 */
router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true });
  }),
);

export default router;
