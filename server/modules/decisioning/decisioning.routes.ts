import express from 'express';

import {
  jevCredentials,
  readJevSettings,
  testJevConnection,
  updateJevSettings,
} from '@/modules/decisioning/jev.service.js';
import type { JevSettingsPatch } from '@/modules/decisioning/jev.types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

export const decisioningRoutes = express.Router();

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

decisioningRoutes.get('/settings', (_req, res) => {
  res.json(createApiSuccessResponse({ settings: readJevSettings(), key: jevCredentials.status() }));
});

decisioningRoutes.put('/settings', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: JevSettingsPatch = {
    enabled: optionalBoolean(body.enabled),
    model: optionalString(body.model),
    baseUrl: optionalString(body.baseUrl),
    timeoutMs: optionalNumber(body.timeoutMs),
    confidenceThreshold: optionalNumber(body.confidenceThreshold),
    // Unknown capability keys are dropped by the service, so passing the raw
    // object through is safe and keeps this route additive as capabilities grow.
    capabilities: body.capabilities as JevSettingsPatch['capabilities'],
    relayMayApprovePermissions: optionalBoolean(body.relayMayApprovePermissions),
  };
  res.json(createApiSuccessResponse({ settings: updateJevSettings(patch) }));
});

// The TypeSafe key is stored apart from the settings JSON, so it has its own
// tiny surface. Only ever masked on the way out — no route returns the raw key.
decisioningRoutes.get('/key', (_req, res) => {
  res.json(createApiSuccessResponse({ key: jevCredentials.status() }));
});

decisioningRoutes.put('/key', (req, res) => {
  const apiKey = optionalString((req.body ?? {}).apiKey);
  if (!apiKey) throw new AppError('apiKey is required.', { code: 'JEV_KEY_REQUIRED', statusCode: 400 });
  jevCredentials.set(apiKey);
  res.json(createApiSuccessResponse({ key: jevCredentials.status() }));
});

decisioningRoutes.delete('/key', (_req, res) => {
  jevCredentials.clear();
  res.json(createApiSuccessResponse({ key: jevCredentials.status() }));
});

decisioningRoutes.post('/test', asyncHandler(async (_req, res) => {
  // Uses the saved settings so the check exercises the same model, base URL,
  // and credential the live decision paths would use.
  res.json(createApiSuccessResponse({ test: await testJevConnection(readJevSettings()) }));
}));
