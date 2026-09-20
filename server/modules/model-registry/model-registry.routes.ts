import express from 'express';

import {
  getStaffingPrefs,
  listModelCapabilities,
  refreshModelRegistry,
  registryIsStale,
  setModelEnabled,
  setStaffingPrefs,
} from '@/modules/model-registry/model-registry.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

// ——— Model Capability Registry (automated staffing source) ———

router.get(
  '/model-registry',
  asyncHandler(async (_req, res) => {
    let capabilities = listModelCapabilities();
    if (capabilities.length === 0) {
      await refreshModelRegistry({});
      capabilities = listModelCapabilities();
    }
    res.json({
      success: true,
      capabilities,
      stale: registryIsStale(),
    });
  }),
);

router.patch(
  '/model-registry/models',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Array.isArray(body.models)) {
      for (const item of body.models) {
        if (item && typeof item === 'object' && typeof item.provider === 'string' && typeof item.modelId === 'string') {
          setModelEnabled(item.provider.trim(), item.modelId.trim(), item.enabled !== false);
        }
      }
      res.json({ success: true, capabilities: listModelCapabilities(), stale: registryIsStale() });
      return;
    }
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    if (!provider || !modelId) {
      throw new AppError('provider and modelId are required', { code: 'BAD_REQUEST', statusCode: 400 });
    }
    const enabled = body.enabled !== false;
    const ok = setModelEnabled(provider, modelId, enabled);
    if (!ok) {
      throw new AppError('Model not found in registry', { code: 'NOT_FOUND', statusCode: 404 });
    }
    res.json({ success: true, capabilities: listModelCapabilities(), stale: registryIsStale() });
  }),
);

router.get(
  '/model-registry/prefs',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, prefs: getStaffingPrefs() });
  }),
);

router.put(
  '/model-registry/prefs',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedProviders = Array.isArray(body.allowedProviders)
      ? body.allowedProviders.filter((item): item is string => typeof item === 'string')
      : body.allowedProviders === null
        ? null
        : undefined;
    const prefs = setStaffingPrefs({
      allowedProviders,
      defaultOrchestratorProvider:
        body.defaultOrchestratorProvider === null
          ? null
          : typeof body.defaultOrchestratorProvider === 'string'
            ? body.defaultOrchestratorProvider
            : undefined,
      defaultOrchestratorModel:
        body.defaultOrchestratorModel === null
          ? null
          : typeof body.defaultOrchestratorModel === 'string'
            ? body.defaultOrchestratorModel
            : undefined,
    });
    res.json({ success: true, prefs });
  }),
);

router.post(
  '/model-registry/refresh',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { providers?: unknown };
    const providers = Array.isArray(body.providers)
      ? body.providers.filter((p): p is string => typeof p === 'string')
      : undefined;
    const result = await refreshModelRegistry({ providers });
    res.json({ success: true, ...result, capabilities: listModelCapabilities(), stale: registryIsStale() });
  }),
);

export default router;
export { router as modelRegistryRoutes };
