export { default, default as automationRoutes } from '@/modules/automation/automation.routes.js';
export { automationDb } from '@/modules/automation/automation.repository.js';
export { automationService, startAutomationKernel, stopAutomationKernel, syncSchedules } from '@/modules/automation/automation.service.js';
export * from '@/modules/automation/automation.types.js';
