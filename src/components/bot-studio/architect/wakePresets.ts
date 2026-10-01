/** The "add a wake-up" choices, as drafts ready for the shared trigger fields. */

import { emptyDraft, type EditableKind, type TriggerDraft, type WatchAdapterKind } from '../view/tabs/runtime/triggers/triggerForm';

export type WakePreset = { id: string; label: string; description: string; kinds: EditableKind[]; make: () => TriggerDraft };

const watch = (adapter: WatchAdapterKind) => (): TriggerDraft => ({ ...emptyDraft('watch'), adapter });

export const WAKE_PRESETS: WakePreset[] = [
  { id: 'plain', label: 'In plain English', description: 'For example "weekdays at 9am except fridays".', kinds: ['nl_schedule'], make: () => emptyDraft('nl_schedule') },
  { id: 'webhook', label: 'When something calls a webhook', description: 'A signed web address another system can POST to.', kinds: ['webhook'], make: () => emptyDraft('webhook') },
  { id: 'rss', label: 'A news or blog feed', description: 'Wake when the RSS or Atom feed has something new.', kinds: ['watch'], make: watch('rss') },
  { id: 'folder', label: 'A folder on this computer', description: 'Wake when files appear or change.', kinds: ['watch'], make: watch('directory') },
  { id: 'github', label: 'A GitHub repository', description: 'Wake for new issues, pull requests or notifications.', kinds: ['watch'], make: watch('github') },
  { id: 'json', label: 'A JSON web address', description: 'Wake when a JSON API lists a new item.', kinds: ['watch'], make: watch('http_json') },
  { id: 'run', label: 'When a run completes', description: 'Any agent run finishing, optionally only failed ones.', kinds: ['run_completed'], make: () => emptyDraft('run_completed') },
  { id: 'kanban', label: 'When a board task finishes', description: 'A kanban task reaching Done.', kinds: ['kanban_event'], make: () => ({ ...emptyDraft('kanban_event'), event: 'task.done' }) },
  { id: 'interrupt', label: 'When an interrupt appears', description: 'An approval request or question is raised.', kinds: ['interrupt_created'], make: () => emptyDraft('interrupt_created') },
];

export const COALESCING_EXPLANATION = 'Signals that arrive close together are merged into one wake-up (about 5 seconds by default), so twenty webhooks in a burst wake the bot once, not twenty times. Change the window per wake-up under its details.';
