export { default as failoverRoutes } from '@/modules/failover/failover.routes.js';
export { failoverDb } from '@/modules/failover/failover.repository.js';
export {
  configureFailoverApprovalResolver,
  configureFailoverRuntimes,
  failoverService,
} from '@/modules/failover/failover.service.js';
export * from '@/modules/failover/failover.types.js';
