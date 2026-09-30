import { registerBotsRuntimeHook } from '@/modules/bots/bots-runtime.boot.js';
import { onEpisodeFinished } from '@/modules/bots/kernel/kernel.service.js';
import { onItemFeedback } from '@/modules/mission-control/index.js';
import { captureItemFeedback } from '@/modules/bots/learning/feedback.js';
import { operatorProfile } from '@/modules/bots/learning/operator-profile.service.js';
import { reflector, SWEEP_INTERVAL_MS } from '@/modules/bots/learning/reflector.js';

export { botLearningRouter } from '@/modules/bots/learning/learning.routes.js';
export { learning } from '@/modules/bots/learning/learning.service.js';
export { reflector, reflectBot, SWEEP_INTERVAL_MS } from '@/modules/bots/learning/reflector.js';
export { skills } from '@/modules/bots/learning/skills.service.js';
export { operatorProfile, operatorProfileContext } from '@/modules/bots/learning/operator-profile.service.js';
export { evalsBridge } from '@/modules/bots/learning/evals-bridge.js';
export { shadow, type ShadowRunner, type ShadowResult } from '@/modules/bots/learning/shadow.js';
export { privacy, type PurgeSelection } from '@/modules/bots/learning/privacy.service.js';
export { setSkillDrafter, type SkillDrafter } from '@/modules/bots/learning/skill-draft.js';
export { captureItemFeedback, collectFeedback } from '@/modules/bots/learning/feedback.js';

const REFLECT_DEBOUNCE_MS = 2_000;

let disposers: Array<() => void> = [];
let hookRegistered = false;
let sweepTimer: NodeJS.Timeout | null = null;
const debounce = new Map<string, NodeJS.Timeout>();

function scheduleReflect(botId: string): void {
  if (debounce.has(botId)) return;
  const timer = setTimeout(() => {
    debounce.delete(botId);
    void reflector.reflectBot(botId).catch((error: unknown) => {
      console.warn('[bots] reflection failed', { botId, error: error instanceof Error ? error.message : error });
    });
  }, REFLECT_DEBOUNCE_MS);
  timer.unref?.();
  debounce.set(botId, timer);
}

function startTimers(): void {
  if (sweepTimer) return;
  operatorProfile.syncFromFile();
  sweepTimer = setInterval(() => {
    void reflector.sweep().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function stopTimers(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const timer of debounce.values()) clearTimeout(timer);
  debounce.clear();
}

/** Remove the listeners and timers (tests, or a clean shutdown). */
export function uninstallLearning(): void {
  stopTimers();
  for (const dispose of disposers) dispose();
  disposers = [];
}

/**
 * Wire the learning loop: feedback capture and the reflector listen immediately; the 30 minute sweep
 * and the operator-profile file sync run through the runtime lifecycle hook. Idempotent.
 */
export function installLearning(): void {
  if (disposers.length === 0) {
    disposers.push(
      onItemFeedback((event) => {
        const captured = captureItemFeedback(event);
        if (captured && event.actor === 'human') scheduleReflect(event.sectionId);
      }),
      onEpisodeFinished(async (episode) => {
        await reflector.onEpisodeFinished(episode.episode_id);
      }),
    );
  }
  if (!hookRegistered) {
    hookRegistered = true;
    registerBotsRuntimeHook({ start: startTimers, stop: stopTimers });
  }
}
