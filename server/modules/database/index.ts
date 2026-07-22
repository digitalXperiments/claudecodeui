export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { categoriesDb } from '@/modules/database/repositories/categories.db.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
export { projectMemoryDb } from '@/modules/database/repositories/project-memory.db.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export {
  agentRunProfilesDb,
  compilePermissionIntent,
} from '@/modules/database/repositories/agent-run-profiles.db.js';
export type {
  AgentRunProfile,
  AgentRunProfileTools,
  CreateAgentRunProfileInput,
  UpdateAgentRunProfileInput,
} from '@/modules/database/repositories/agent-run-profiles.db.js';
export { systemNotificationsDb } from '@/modules/database/repositories/system-notifications.db.js';
export type {
  SystemNotification,
  CreateSystemNotificationInput,
  SystemNotificationKind,
} from '@/modules/database/repositories/system-notifications.db.js';
