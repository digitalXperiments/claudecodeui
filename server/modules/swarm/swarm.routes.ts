import express from 'express';

import { swarmService } from '@/modules/swarm/swarm.service.js';
import {
  getStaffingPrefs,
  listModelCapabilities,
  refreshModelRegistry,
  registryIsStale,
  setModelEnabled,
  setStaffingPrefs,
} from '@/modules/swarm/model-registry.service.js';
import { swarmDb } from '@/modules/swarm/swarm.repository.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function optionalString(value: unknown): string | undefined {
  const v = stringValue(value);
  return v || undefined;
}

/** Agent Swarm is retired; new work goes through Agent Relay. */
function swarmRetired(): never {
  throw new AppError(
    'Agent Swarm is retired. Use Agent Relay for delegated work.',
    { code: 'SWARM_RETIRED', statusCode: 410 },
  );
}

const refuseSwarmMutation = asyncHandler(async () => {
  swarmRetired();
});

router.get(
  '/swarm',
  asyncHandler(async (req, res) => {
    const projectId = optionalString(req.query.projectId);
    const limitRaw = optionalString(req.query.limit);
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw) || 50)) : 50;
    const archivedOnly = req.query.archivedOnly === 'true' || req.query.archivedOnly === '1';
    const includeArchived =
      archivedOnly ||
      req.query.includeArchived === 'true' ||
      req.query.includeArchived === '1';
    // Global list when projectId omitted — Agent Swarm is a first-class surface.
    res.json({
      success: true,
      swarms: swarmService.list(projectId ?? null, limit, {
        includeArchived,
        archivedOnly,
      }),
    });
  }),
);

router.get(
  '/swarm/defaults',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      roster: swarmService.defaultRoster(),
      kinds: ['orchestrator', 'explorer', 'implementer', 'reviewer', 'tester', 'security', 'docs', 'custom'],
      staffing: getStaffingPrefs(),
      autonomousDefault: true,
    });
  }),
);

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

router.post('/swarm/auto-staff-preview', refuseSwarmMutation);

router.post('/swarm/draft-goal', refuseSwarmMutation);

router.post('/swarm', refuseSwarmMutation);

router.get(
  '/swarm/:swarmId/artifacts',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    const swarm = swarmService.get(swarmId);
    if (!swarm) throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, artifacts: swarm.artifacts ?? [] });
  }),
);

router.get(
  '/swarm/:swarmId/events',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    if (!swarmService.get(swarmId))
      throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    const sinceRaw = optionalString(req.query.since);
    const limitRaw = optionalString(req.query.limit);
    const events = swarmDb.listEventsForSwarm(swarmId, {
      sinceSeq: sinceRaw ? Number(sinceRaw) || undefined : undefined,
      limit: limitRaw ? Math.min(2000, Math.max(1, Number(limitRaw) || 500)) : 500,
    });
    res.json({ success: true, events });
  }),
);

router.get(
  '/swarm/:swarmId/metrics',
  asyncHandler(async (req, res) => {
    const metrics = swarmService.getMetrics(stringValue(req.params.swarmId));
    if (!metrics) throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, metrics });
  }),
);

router.get(
  '/swarm/:swarmId/activity',
  asyncHandler(async (req, res) => {
    const activity = swarmService.getActivity(stringValue(req.params.swarmId));
    if (!activity) throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, activity });
  }),
);

router.get(
  '/swarm/:swarmId',
  asyncHandler(async (req, res) => {
    const swarm = swarmService.get(stringValue(req.params.swarmId));
    if (!swarm) throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, swarm });
  }),
);

// Pre-PR validation report (PDF preferred, HTML fallback) written by the
// stability gate under the primary project's tmp/cloudcli/swarm-reports/.
router.get(
  '/swarm/:swarmId/report',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    const report = swarmService.validationReport(swarmId);
    if (!report)
      throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    const file = report.pdfPath ?? report.htmlPath;
    if (!file)
      throw new AppError('No validation report has been generated for this swarm', {
        code: 'SWARM_REPORT_NOT_FOUND',
        statusCode: 404,
      });
    res.sendFile(file);
  }),
);

// Small JSON summary of the validation gate (check statuses, artifact paths).
router.get(
  '/swarm/:swarmId/report/summary',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    const report = swarmService.validationReport(swarmId);
    if (!report)
      throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    if (!report.summaryPath)
      throw new AppError('No validation summary has been generated for this swarm', {
        code: 'SWARM_REPORT_NOT_FOUND',
        statusCode: 404,
      });
    res.sendFile(report.summaryPath);
  }),
);

router.post('/swarm/:swarmId/fork', refuseSwarmMutation);
router.post('/swarm/:swarmId/complete-member', refuseSwarmMutation);
router.post('/swarm/:swarmId/synthesize', refuseSwarmMutation);
router.post('/swarm/:swarmId/approve', refuseSwarmMutation);
router.post('/swarm/:swarmId/reject', refuseSwarmMutation);
router.post('/swarm/:swarmId/approve-plan', refuseSwarmMutation);
router.post('/swarm/:swarmId/reject-plan', refuseSwarmMutation);
router.post('/swarm/:swarmId/abort', refuseSwarmMutation);
router.post('/swarm/:swarmId/retry-step', refuseSwarmMutation);
router.post('/swarm/:swarmId/resume', refuseSwarmMutation);
router.post('/swarm/:swarmId/archive', refuseSwarmMutation);
router.delete('/swarm/:swarmId', refuseSwarmMutation);

export default router;
