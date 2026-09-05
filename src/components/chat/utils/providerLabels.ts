import type { TFunction } from 'i18next';

/**
 * Speaker/provider label per provider id.
 *
 * A map rather than the ternary chains this replaces: those all ended in
 * `messageTypes.claude`, so every provider added after a chain was written
 * introduced itself as "Claude" (Antigravity, Qwen Code and Cline all did).
 * The `defaultValue` keeps a label present for locales that lack the key.
 */
const PROVIDER_MESSAGE_TYPES: Record<string, { key: string; label: string }> = {
  claude: { key: 'messageTypes.claude', label: 'Claude' },
  cursor: { key: 'messageTypes.cursor', label: 'Cursor' },
  codex: { key: 'messageTypes.codex', label: 'Codex' },
  opencode: { key: 'messageTypes.opencode', label: 'OpenCode' },
  kilo: { key: 'messageTypes.kilo', label: 'Kilo Code' },
  cline: { key: 'messageTypes.cline', label: 'Cline' },
  grok: { key: 'messageTypes.grok', label: 'Grok Build' },
  kimi: { key: 'messageTypes.kimi', label: 'Kimi' },
  qwencode: { key: 'messageTypes.qwencode', label: 'Qwen Code' },
  pi: { key: 'messageTypes.pi', label: 'Pi' },
  omp: { key: 'messageTypes.omp', label: 'Oh My Pi' },
  antigravity: { key: 'messageTypes.antigravity', label: 'Antigravity' },
};

/** Translated display name for `provider`; unknown ids fall back to Claude. */
export function providerMessageTypeLabel(
  t: TFunction,
  provider: string | null | undefined,
): string {
  const entry = PROVIDER_MESSAGE_TYPES[String(provider)] ?? PROVIDER_MESSAGE_TYPES.claude;
  return t(entry.key, { defaultValue: entry.label });
}

export { PROVIDER_MESSAGE_TYPES };
