import type { LLMProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  kimi: 'Kimi',
  pi: 'Pi',
};

export const FANOUT_PROVIDERS: LLMProvider[] = [
  'claude',
  'cursor',
  'codex',
  'opencode',
  'grok',
  'kimi',
];

type ProviderBindingMatrixProps = {
  selected: LLMProvider[];
  onChange: (providers: LLMProvider[]) => void;
  /** Providers that cannot be toggled (e.g. unsupported transport). */
  disabledProviders?: LLMProvider[];
  disabledReason?: (provider: LLMProvider) => string | undefined;
  /** When true, all checkboxes are locked (provider-cloud rows). */
  locked?: boolean;
  lockedMessage?: string;
  className?: string;
  providers?: LLMProvider[];
};

/**
 * Shared fan-out matrix for MCP and Skills: explicit per-provider enable.
 * No provider is enabled unless checked — isolation by default.
 */
export default function ProviderBindingMatrix({
  selected,
  onChange,
  disabledProviders = [],
  disabledReason,
  locked = false,
  lockedMessage,
  className,
  providers = FANOUT_PROVIDERS,
}: ProviderBindingMatrixProps) {
  const selectedSet = new Set(selected);
  const disabledSet = new Set(disabledProviders);

  const toggle = (provider: LLMProvider) => {
    if (locked || disabledSet.has(provider)) {
      return;
    }
    if (selectedSet.has(provider)) {
      onChange(selected.filter((p) => p !== provider));
    } else {
      onChange([...selected, provider]);
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="text-xs font-medium text-foreground">Available on</div>
      {locked && lockedMessage && (
        <p className="text-xs text-muted-foreground">{lockedMessage}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {providers.map((provider) => {
          const isOn = selectedSet.has(provider);
          const isDisabled = locked || disabledSet.has(provider);
          const reason = disabledReason?.(provider);
          return (
            <label
              key={provider}
              title={reason || undefined}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                isOn && !isDisabled
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground',
                isDisabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-border"
                checked={isOn}
                disabled={isDisabled}
                onChange={() => toggle(provider)}
              />
              {PROVIDER_LABELS[provider] ?? provider}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export { PROVIDER_LABELS };
