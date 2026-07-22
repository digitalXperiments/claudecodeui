import { ActivityIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Single context chip: used amount + fill % when the window is known.
 * Click opens the full token usage modal.
 */
export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? (usage.breakdown as Record<string, unknown>)
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const contextUsed = readUsageNumber(usage?.contextUsed);
  const contextWindow = readUsageNumber(usage?.contextWindow ?? usage?.total);
  const cumulativeUsed = readUsageNumber(usage?.cumulativeUsed) || inputTokens + outputTokens;

  const hasContextFill = contextUsed > 0;
  const hasWindow = contextWindow > 0;
  const usedTokens = hasContextFill
    ? contextUsed
    : readUsageNumber(usage?.used) || cumulativeUsed;

  if (usedTokens <= 0 && !hasWindow) {
    return null;
  }

  const pct =
    hasContextFill && hasWindow
      ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
      : hasWindow && usedTokens > 0
        ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
        : null;

  const label =
    pct != null
      ? `${formatTokenCount(usedTokens)} · ${pct}%`
      : formatTokenCount(usedTokens);

  const title = [
    `${usedTokens.toLocaleString()} tokens in context`,
    hasWindow ? `${contextWindow.toLocaleString()} window max` : null,
    pct != null ? `${pct}% filled` : null,
    cumulativeUsed > usedTokens ? `${cumulativeUsed.toLocaleString()} session spend` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-2.5"
      title={title}
      aria-label={
        pct != null
          ? `Context ${usedTokens.toLocaleString()} tokens, ${pct}% of window`
          : `Context ${usedTokens.toLocaleString()} tokens`
      }
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="whitespace-nowrap font-medium tabular-nums text-foreground">{label}</span>
    </button>
  );
}
