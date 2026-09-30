import { registerBotsRuntimeHook } from '@/modules/bots/bots-runtime.boot.js';
import { onEpisodeFinished } from '@/modules/bots/kernel/kernel.service.js';
import { registerCollabGatewayTools } from '@/modules/bots/collab/collab-tools.js';
import { deliverAskReplies } from '@/modules/bots/collab/messaging.service.js';

let installed = false;
let unsubscribe: (() => void) | null = null;

/**
 * Register the collaboration gateway tools and the ask-reply delivery listener. Idempotent.
 * The lead additionally registers `collabPerceiveSection` with the kernel's perceive registry.
 */
export function installCollab(): void {
  if (installed) return;
  installed = true;
  registerCollabGatewayTools();
  registerBotsRuntimeHook({
    start: () => {
      unsubscribe?.();
      unsubscribe = onEpisodeFinished(async (episode) => {
        await deliverAskReplies(episode);
      });
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}
