import { registerHandoffGatewayTool, initBotHandoff } from './handoff.js';

let installed = false;

/**
 * Wire the execution substrate: the `bot__request_handoff` gateway tool and the interrupt queue's
 * `done` / `cancel` handoff actions. Idempotent. Bot-home working directories, per-phase routing
 * failover and per-bot credentials need no wiring (they live in the agent service and the
 * gateway's upstream pool); mount `botExecRouter` before `botKernelRouter`.
 */
export function installExec(): void {
  if (installed) return;
  installed = true;
  registerHandoffGatewayTool();
  initBotHandoff();
}
