export { default as authHealthRoutes } from '@/modules/auth-health/auth-health.routes.js';
export {
  checkAuthHealth,
  getLastAuthHealthReport,
  planAuthHealthNotifications,
  planMcpHealthNotifications,
  applyAuthHealthOutcomes,
  getDisabledProviders,
  setDisabledProviders,
  REAUTH_HINTS,
  AUTH_HEALTH_DEDUPE_PREFIX,
  RENOTIFY_COOLDOWN_MS,
  DISABLED_AGENTS_CONFIG_KEY,
} from '@/modules/auth-health/auth-health.service.js';
export type {
  AuthHealthReport,
  AuthHealthProviderReport,
  AuthHealthOpenNotification,
  AuthHealthPlanAction,
} from '@/modules/auth-health/auth-health.service.js';
export {
  checkMcpServerHealth,
  probeMcpServerHealth,
  probeUrlReachable,
  resolveExecutableOnPath,
  MCP_HEALTH_DEDUPE_PREFIX,
} from '@/modules/auth-health/mcp-health.service.js';
export type {
  McpServerHealthReport,
  McpServerHealthProbe,
  McpServerHealthStatus,
} from '@/modules/auth-health/mcp-health.service.js';
export {
  startAuthHealthWatchdog,
  stopAuthHealthWatchdog,
} from '@/modules/auth-health/auth-health-watchdog.service.js';
