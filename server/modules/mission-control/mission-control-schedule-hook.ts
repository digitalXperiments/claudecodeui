/**
 * A one-way hook the bot kernel registers so Mission Control paths that create or edit sections
 * outside the HTTP routes (legacy import, seeds) can keep the bot's mirrored cron trigger in
 * step. Injected rather than imported because `@/modules/bots` already imports this module.
 */

type SectionScheduleHook = (sectionId: string) => void;

let hook: SectionScheduleHook | null = null;

export function setSectionScheduleHook(next: SectionScheduleHook | null): void {
  hook = next;
}

/** Tell the registered hook (if any) that a section's schedule may have changed. Never throws. */
export function notifySectionScheduleChanged(sectionId: string): void {
  if (!hook) return;
  try {
    hook(sectionId);
  } catch (error) {
    console.warn('[MissionControl] section schedule hook failed', { sectionId, error: error instanceof Error ? error.message : String(error) });
  }
}
