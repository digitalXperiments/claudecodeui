import { setSectionScheduleHook } from '@/modules/mission-control/index.js';
import { registerBotsRuntimeHook, setBotsRuntimeWakeHandler } from '@/modules/bots/bots-runtime.boot.js';
import { setHumanWaitHooks } from '@/modules/bots/gate/action-gate.service.js';
import { extendEpisodeDeadline, kernel, syncBotScheduleTrigger } from '@/modules/bots/kernel/kernel.service.js';
import { registerKernelGatewayTools } from '@/modules/bots/kernel/kernel-tools.js';

let installed = false;

/** Wire the kernel into the runtime boot: wake handler, lifecycle hook, first-party tools. Idempotent. */
export function installKernel(): void {
  if (installed) return;
  installed = true;
  // A gate ask waiting on a human keeps its episode alive (the kernel caps the total stretch).
  setHumanWaitHooks({ extendDeadline: extendEpisodeDeadline });
  registerKernelGatewayTools();
  // Legacy import and seeds create sections outside the routes: keep their cron mirrored too.
  setSectionScheduleHook(syncBotScheduleTrigger);
  setBotsRuntimeWakeHandler((botId) => kernel.notify(botId));
  registerBotsRuntimeHook({
    start: () => kernel.start(),
    stop: () => kernel.stop(),
  });
}
