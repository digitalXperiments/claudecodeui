/**
 * Tools whose "execution" is really a request for user input rather than a
 * side-effecting action: the model calls them to ask the user something
 * (`AskUserQuestion`) or to hand a plan back for approval (`ExitPlanMode`).
 *
 * A provider runtime must intercept these and surface an interactive prompt to
 * the UI instead of silently auto-approving or letting the model act on a
 * fabricated answer. This lives in a shared, provider-neutral module (rather
 * than inside the Claude SDK adapter) so any adapter can classify them
 * identically as it gains an interactive answer round-trip.
 */
/**
 * Canonical CloudCLI / Claude names plus Grok ACP snake_case aliases so every
 * provider adapter can classify interactive tools the same way.
 */
export const TOOLS_REQUIRING_INTERACTION = new Set<string>([
  'AskUserQuestion',
  'ask_user_question',
  'ExitPlanMode',
  'exit_plan_mode',
]);

/** Map provider-native tool names onto the CloudCLI UI panel ids. */
export function normalizeInteractiveToolName(toolName: string): string {
  if (toolName === 'ask_user_question') return 'AskUserQuestion';
  if (toolName === 'exit_plan_mode') return 'ExitPlanMode';
  return toolName;
}

/** Whether a tool call should pause the run for an interactive user prompt. */
export function isInteractiveTool(toolName: string): boolean {
  return TOOLS_REQUIRING_INTERACTION.has(toolName);
}
