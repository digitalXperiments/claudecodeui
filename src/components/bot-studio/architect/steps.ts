/**
 * The wizard's step list. With runtime v2 off (or when editing) it is exactly the original eight
 * steps; with it on, a new bot also gets Goals and Reach me (10 steps in total). Steps are looked up
 * by id, never by position, so inserting one cannot silently re-point a "go to step N" jump.
 */

export type ArchitectStepId =
  | 'purpose' | 'agent' | 'brief' | 'goals' | 'tools' | 'triggers' | 'outputs' | 'guardrails' | 'reach' | 'review';

export type ArchitectStep = { id: ArchitectStepId; title: string; hint: string };

const PURPOSE: ArchitectStep = { id: 'purpose', title: 'Purpose', hint: 'Name, scope, and outcome' };
const AGENT: ArchitectStep = { id: 'agent', title: 'Agent', hint: 'Provider and safety' };
const BRIEF: ArchitectStep = { id: 'brief', title: 'Brief', hint: 'What to look for and resolve' };
const TOOLS: ArchitectStep = { id: 'tools', title: 'Tools', hint: 'MCP servers and policies' };
const OUTPUTS: ArchitectStep = { id: 'outputs', title: 'Outputs & actions', hint: 'Approval and dry run' };
const REVIEW: ArchitectStep = { id: 'review', title: 'Review', hint: 'Check and create' };

/** The original wizard. Titles and hints are unchanged so the flag-off wizard is byte-for-byte what shipped. */
const CLASSIC_STEPS: ArchitectStep[] = [
  PURPOSE, AGENT, BRIEF, TOOLS,
  { id: 'triggers', title: 'Triggers', hint: 'When a tick runs' },
  OUTPUTS,
  { id: 'guardrails', title: 'Guardrails', hint: 'Safety recap' },
  REVIEW,
];

const RUNTIME_STEPS: ArchitectStep[] = [
  PURPOSE, AGENT, BRIEF,
  { id: 'goals', title: 'Goals', hint: 'What good looks like' },
  TOOLS,
  { id: 'triggers', title: 'Wake-ups', hint: 'When the bot wakes up' },
  OUTPUTS,
  { id: 'guardrails', title: 'Guardrails', hint: 'Safety floor, rules, budget' },
  { id: 'reach', title: 'Reach me', hint: 'Channels and learning' },
  REVIEW,
];

export const MAX_ARCHITECT_STEPS = 10;

/** `runtimeWizard` is true only for a NEW bot with `bots.runtimeV2` on. */
export function architectSteps(runtimeWizard: boolean): ArchitectStep[] {
  return runtimeWizard ? RUNTIME_STEPS : CLASSIC_STEPS;
}

/** 1-based index of a step in the list, or 1 when this wizard does not have it (never throws). */
export function stepNumber(steps: ArchitectStep[], id: ArchitectStepId): number {
  const index = steps.findIndex((step) => step.id === id);
  return index >= 0 ? index + 1 : 1;
}

/** Zero-padded eyebrow, "05 · Triggers", derived from the live position. */
export function stepEyebrow(steps: ArchitectStep[], id: ArchitectStepId, label?: string): string {
  const number = stepNumber(steps, id);
  const title = label ?? steps.find((step) => step.id === id)?.title ?? '';
  return `${String(number).padStart(2, '0')} · ${title}`;
}
