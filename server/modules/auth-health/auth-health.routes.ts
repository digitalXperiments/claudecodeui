import express from 'express';

import {
  applyAuthHealthOutcomes,
  checkAuthHealth,
  getDisabledProviders,
  getLastAuthHealthReport,
  setDisabledProviders,
} from '@/modules/auth-health/auth-health.service.js';
import { refreshSessionsWatcher } from '@/modules/providers/index.js';
import { asyncHandler } from '@/shared/utils.js';

const router = express.Router();

/** Last watchdog report; runs a first check if the watchdog never ran. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const report = getLastAuthHealthReport() ?? (await checkAuthHealth());
    res.json({ success: true, ...report });
  }),
);

/** Fresh on-demand probe (bypasses cached provider status) + notify/recover pass. */
router.post(
  '/check',
  asyncHandler(async (_req, res) => {
    const report = await checkAuthHealth({ fresh: true });
    await applyAuthHealthOutcomes(report);
    res.json({ success: true, ...report });
  }),
);

/** Providers the watchdog skips (turned off in Settings → Agents). */
router.get(
  '/disabled-providers',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, disabled: [...getDisabledProviders()] });
  }),
);

/**
 * Syncs the disabled-provider list from the frontend, then immediately
 * dismisses any stale open alerts for the newly disabled providers and
 * re-arms the sessions watcher so toggled providers are (un)watched.
 */
router.put(
  '/disabled-providers',
  asyncHandler(async (req, res) => {
    const disabled = setDisabledProviders(req.body?.disabled);
    // Empty report: the planner only acts on the disabled set (dismiss pass).
    await applyAuthHealthOutcomes({ checkedAt: new Date().toISOString(), providers: [] });
    try {
      await refreshSessionsWatcher();
    } catch (error) {
      // Config is already persisted; a watcher re-arm failure must not 500 the toggle.
      console.warn('[auth-health] failed to refresh sessions watcher:', error);
    }
    res.json({ success: true, disabled });
  }),
);

export default router;
