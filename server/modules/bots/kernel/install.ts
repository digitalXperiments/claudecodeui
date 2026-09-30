import { setSectionScheduleHook } from '@/modules/mission-control/index.js';
import { registerBotsRuntimeHook, setBotsRuntimeWakeHandler } from '@/modules/bots/bots-runtime.boot.js';
import { kernel, syncBotScheduleTrigger } from '@/modules/bots/kernel/kernel.service.js';
import { registerKernelGatewayTools } from '@/modules/bots/kernel/kernel-tools.js';

let installed = false;

/** Wire the kernel into the runtime boot: wake handler, lifecycle hook, first-party tools. Idempotent. */
export function installKernel(): void {
  if (installed) return;
  installed = true;
  registerKernelGatewayTools();
  // Legacy import and seeds create sections outside the routes: keep their cron mirrored too.
  setSectionScheduleHook(syncBotScheduleTrigger);
  setBotsRuntimeWakeHandler((botId) => kernel.notify(botId));
  registerBotsRuntimeHook({
    start: () => kernel.start(),
    stop: () => kernel.stop(),
  });
}
