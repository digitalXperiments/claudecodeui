import { registerBotsRuntimeHook } from '@/modules/bots/bots-runtime.boot.js';
import { setKernelNotifier } from '@/modules/bots/kernel/kernel-notifier.js';
import { setHumanWaitHooks } from '@/modules/bots/gate/action-gate.service.js';
import { announceApprovalExpired, announceApprovalReminder, startApprovalFanout, stopApprovalFanout } from '@/modules/bots/channels/approvals.js';
import { startBriefScheduler, stopBriefScheduler } from '@/modules/bots/channels/brief.service.js';
import { notifyOperator } from '@/modules/bots/channels/notify.service.js';
import { startEpisodeReplies } from '@/modules/bots/channels/replies.js';
import { startTelegramPolling, stopTelegramPolling } from '@/modules/bots/channels/telegram-inbound.js';

let installed = false;
let stopReplies: (() => void) | null = null;

/**
 * Wire channels into the runtime: the kernel's `notify` goes through `notifyOperator`, and the
 * lifecycle hook starts approval fan-out, episode replies, Telegram polling and the brief.
 * Idempotent.
 */
export function installChannels(): void {
  if (installed) return;
  installed = true;
  // A pending approval: remind the operator once at half the wait, and tell them (thread + channels)
  // when it timed out and the bot stopped waiting.
  setHumanWaitHooks({ onReminder: announceApprovalReminder, onExpired: announceApprovalExpired });
  setKernelNotifier(async (notification) => {
    await notifyOperator({
      botId: notification.botId,
      title: notification.title,
      body: notification.body,
      urgency: notification.urgency,
    });
  });
  registerBotsRuntimeHook({
    start: () => {
      startApprovalFanout();
      stopReplies?.();
      stopReplies = startEpisodeReplies();
      startTelegramPolling();
      startBriefScheduler();
    },
    stop: () => {
      stopApprovalFanout();
      stopReplies?.();
      stopReplies = null;
      stopTelegramPolling();
      stopBriefScheduler();
    },
  });
}
