/** Input validation for the parts of `runtime_json` the execution substrate owns. */
import {
  BOT_AUTONOMY_LEVELS,
  LEGACY_AUTONOMY,
  MAX_APPROVAL_TIMEOUT_MINUTES,
  MIN_APPROVAL_TIMEOUT_MINUTES,
  isKnownRouteProvider,
  MAX_FALLBACK_ROUTES,
  parseBotAutonomy,
  type BotPhaseRoute,
} from '../bots-runtime-config.js';

export const BACKEND_NOT_IMPLEMENTED = 'not implemented — run the whole server on a remote box (see HEADLESS.md)';

/** Null when `value` is an acceptable `runtime_json.backend` (absent, null or 'local'). */
export function validateBackend(value: unknown): string | null {
  if (value === undefined || value === null || value === 'local') return null;
  if (value === 'docker' || value === 'ssh') return `Backend "${value}" is ${BACKEND_NOT_IMPLEMENTED}`;
  return 'backend must be "local"';
}

/** Null when `value` is a valid `routing.fallback` list (or null/undefined to clear it). */
export function validateFallbackRoutes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return 'routing.fallback must be an array';
  if (value.length > MAX_FALLBACK_ROUTES) return `routing.fallback can hold at most ${MAX_FALLBACK_ROUTES} entries`;
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `routing.fallback[${index}] must be an object`;
    const route = entry as Record<string, unknown>;
    if (!isKnownRouteProvider(route.provider)) return `routing.fallback[${index}].provider is not a known provider`;
    for (const key of ['model', 'effort'] as const) {
      if (route[key] !== undefined && route[key] !== null && typeof route[key] !== 'string') return `routing.fallback[${index}].${key} must be a string`;
    }
  }
  return null;
}

/** Null when `value` is a valid `autonomy` (absent, null to reset, one of the three levels, or an old name for one). */
export function validateAutonomy(value: unknown): string | null {
  if (value === undefined || value === null || parseBotAutonomy(value)) return null;
  return `autonomy must be one of ${BOT_AUTONOMY_LEVELS.join(', ')} (old names ${Object.keys(LEGACY_AUTONOMY).join(', ')} are also accepted)`;
}

/** Null when `value` is a valid `approval_timeout_minutes` (absent, null to reset, or an integer in range). */
export function validateApprovalTimeout(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_APPROVAL_TIMEOUT_MINUTES && value <= MAX_APPROVAL_TIMEOUT_MINUTES) return null;
  return `approval_timeout_minutes must be a whole number from ${MIN_APPROVAL_TIMEOUT_MINUTES} to ${MAX_APPROVAL_TIMEOUT_MINUTES}`;
}

/** First validation error across backend, autonomy and routing.fallback, or null. */
export function validateRuntimeConfigInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const backend = validateBackend(body.backend);
  if (backend) return backend;
  const autonomy = validateAutonomy(body.autonomy);
  if (autonomy) return autonomy;
  const timeout = validateApprovalTimeout(body.approval_timeout_minutes);
  if (timeout) return timeout;
  if (body.gateway !== undefined && body.gateway !== null && typeof body.gateway !== 'boolean') return 'gateway must be a boolean';
  const routing = body.routing;
  if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
    return validateFallbackRoutes((routing as Record<string, unknown>).fallback);
  }
  return null;
}

export function cleanFallbackRoutes(value: unknown): BotPhaseRoute[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const route = entry as Record<string, unknown>;
    const out: BotPhaseRoute = { provider: String(route.provider) };
    if (typeof route.model === 'string' && route.model.trim()) out.model = route.model.trim();
    if (typeof route.effort === 'string' && route.effort.trim()) out.effort = route.effort.trim();
    return out;
  });
}
