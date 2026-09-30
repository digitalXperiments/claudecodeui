import type { CreateMcSectionInput, McSectionWorkshopDraft } from '../../../mission-control/api/missionControlApi';

export type IterationField = 'title' | 'produce_prompt' | 'resolve_prompt' | 'schedule_cron';

export function buildIterationPatch(draft: McSectionWorkshopDraft, selected: readonly IterationField[]): Partial<CreateMcSectionInput> {
  const patch: Partial<CreateMcSectionInput> = {};
  if (selected.includes('title')) patch.title = draft.title;
  if (selected.includes('produce_prompt')) patch.produce_prompt = draft.producePrompt;
  if (selected.includes('resolve_prompt')) patch.resolve_prompt = draft.resolvePrompt;
  if (selected.includes('schedule_cron')) patch.schedule_cron = draft.scheduleCron;
  return patch;
}
