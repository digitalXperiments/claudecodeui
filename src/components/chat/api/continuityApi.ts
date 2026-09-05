import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';
import type {
  ContinuityBoomerangStatus,
  ContinuityCheckpoint,
  ContinuityHealthMatrix,
  ContinuityPolicy,
  ContinuityPolicySettings,
  ContinuityPreflightResult,
  ContinuityRecovery,
  ContinuitySimulationResult,
  ContinuityState,
} from '../types/continuity';

export const CONTINUITY_DEFAULTS_UPDATED_EVENT = 'cloudcli:continuity-defaults-updated';

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json() as { data?: T; error?: string | { message?: string } } & T;
  if (!response.ok) {
    const error = payload.error;
    throw new Error(typeof error === 'string' ? error : error?.message || `Request failed (${response.status})`);
  }
  return (payload.data ?? payload) as T;
}

export async function fetchContinuityState(sessionId: string): Promise<ContinuityState> {
  const response = await authenticatedFetch(`/api/continuity/sessions/${encodeURIComponent(sessionId)}`);
  return readPayload<ContinuityState>(response);
}

export async function updateContinuityPolicy(
  sessionId: string,
  patch: Partial<ContinuityPolicy>,
): Promise<ContinuityState> {
  const response = await authenticatedFetch(`/api/continuity/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return readPayload<ContinuityState>(response);
}

export async function fetchContinuityDefaults(): Promise<ContinuityPolicySettings> {
  const response = await authenticatedFetch('/api/continuity/defaults');
  const payload = await readPayload<{ defaults: ContinuityPolicySettings }>(response);
  return payload.defaults;
}

export async function updateContinuityDefaults(
  defaults: ContinuityPolicySettings,
): Promise<ContinuityPolicySettings> {
  const response = await authenticatedFetch('/api/continuity/defaults', {
    method: 'PUT',
    body: JSON.stringify(defaults),
  });
  const payload = await readPayload<{ defaults: ContinuityPolicySettings }>(response);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ContinuityPolicySettings>(
      CONTINUITY_DEFAULTS_UPDATED_EVENT,
      { detail: payload.defaults },
    ));
  }
  return payload.defaults;
}

export async function actOnContinuityRecovery(
  recoveryId: string,
  action: 'resume_now' | 'switch_now' | 'cancel',
  targetProvider?: LLMProvider,
): Promise<Pick<ContinuityState, 'recovery'>> {
  const response = await authenticatedFetch(
    `/api/continuity/recoveries/${encodeURIComponent(recoveryId)}/actions`,
    {
      method: 'POST',
      body: JSON.stringify({ action, ...(targetProvider ? { targetProvider } : {}) }),
    },
  );
  return readPayload<Pick<ContinuityState, 'recovery'>>(response);
}

export async function fetchContinuityHealth(): Promise<ContinuityHealthMatrix> {
  const response = await authenticatedFetch('/api/continuity/health');
  return readPayload<ContinuityHealthMatrix>(response);
}

export async function fetchContinuityHistory(limit = 50): Promise<{ limit: number; recoveries: ContinuityRecovery[] }> {
  const response = await authenticatedFetch(`/api/continuity/history?limit=${limit}`);
  return readPayload<{ limit: number; recoveries: ContinuityRecovery[] }>(response);
}

export async function simulateContinuityRecovery(body: {
  sessionId: string;
  sourceProvider: LLMProvider;
  detectedReason?: string;
  policy?: Partial<ContinuityPolicySettings>;
}): Promise<{ simulation: ContinuitySimulationResult }> {
  const response = await authenticatedFetch('/api/continuity/simulate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readPayload<{ simulation: ContinuitySimulationResult }>(response);
}

export async function checkContinuityBoomerang(sessionId: string): Promise<ContinuityBoomerangStatus> {
  const response = await authenticatedFetch(`/api/continuity/sessions/${encodeURIComponent(sessionId)}/boomerang`);
  return readPayload<ContinuityBoomerangStatus>(response);
}

export async function executeContinuityBoomerang(sessionId: string): Promise<{ success: boolean; targetProvider: LLMProvider }> {
  const response = await authenticatedFetch(`/api/continuity/sessions/${encodeURIComponent(sessionId)}/boomerang`, {
    method: 'POST',
  });
  return readPayload<{ success: boolean; targetProvider: LLMProvider }>(response);
}

export async function checkContinuityPreflight(
  sessionId: string,
  provider: LLMProvider,
): Promise<ContinuityPreflightResult> {
  const response = await authenticatedFetch('/api/continuity/preflight', {
    method: 'POST',
    body: JSON.stringify({ sessionId, provider }),
  });
  return readPayload<ContinuityPreflightResult>(response);
}

export async function fetchContinuityCheckpoints(
  sessionId: string,
): Promise<{ latestCheckpoint: ContinuityCheckpoint | null; scratchpad: unknown[]; rootSessionId: string }> {
  const response = await authenticatedFetch(`/api/continuity/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
  return readPayload<{ latestCheckpoint: ContinuityCheckpoint | null; scratchpad: unknown[]; rootSessionId: string }>(response);
}
