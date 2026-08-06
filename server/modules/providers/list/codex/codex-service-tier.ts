/**
 * Codex's user-facing Fast mode maps to the app-server's `priority` service
 * tier. The CLI config uses the friendlier `fast` label, but app-server
 * requests use the catalog-provided tier id.
 */
export const CODEX_FAST_SERVICE_TIER = 'priority' as const;

type CodexServiceTierOptions = {
  fastMode?: unknown;
  serviceTier?: unknown;
};

/**
 * Resolve an app-facing service-tier preference without forwarding arbitrary
 * client values into the Codex protocol.
 *
 * `undefined` means "leave the Codex thread/config default unchanged" while
 * `null` deliberately clears a previously selected tier.
 */
export function resolveCodexServiceTier(
  options: CodexServiceTierOptions = {},
): typeof CODEX_FAST_SERVICE_TIER | null | undefined {
  if (options.serviceTier === null) {
    return null;
  }

  if (
    options.serviceTier === CODEX_FAST_SERVICE_TIER
    || options.serviceTier === 'fast'
    || options.fastMode === true
  ) {
    return CODEX_FAST_SERVICE_TIER;
  }

  return undefined;
}
