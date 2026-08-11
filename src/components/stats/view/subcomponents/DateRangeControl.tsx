import { Button, Input, Pill, PillBar } from '../../../../shared/view/ui';
import { STATS_RANGE_OPTIONS, type StatsRangeKey } from '../../utils/dateRange';

type DateRangeControlProps = {
  rangeKey: StatsRangeKey;
  onRangeKeyChange: (key: StatsRangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  onApplyCustom: () => void;
  disabled?: boolean;
};

/**
 * Preset date-range pills (7/30/90 days, all time) plus an optional custom
 * from/to picker. All widgets on the dashboard consume the same range.
 */
export default function DateRangeControl({
  rangeKey,
  onRangeKeyChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  onApplyCustom,
  disabled,
}: DateRangeControlProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PillBar className="scrollbar-hide min-w-0 flex-1 overflow-x-auto">
        {STATS_RANGE_OPTIONS.map((option) => (
          <Pill
            key={option.key}
            isActive={rangeKey === option.key}
            onClick={() => onRangeKeyChange(option.key)}
            className="flex-shrink-0 whitespace-nowrap"
          >
            {option.label}
          </Pill>
        ))}
      </PillBar>
      {rangeKey === 'custom' ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            From
            <Input
              type="date"
              value={customFrom}
              onChange={(event) => onCustomFromChange(event.target.value)}
              className="h-8 w-36 text-xs"
              aria-label="Custom range start date"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            To
            <Input
              type="date"
              value={customTo}
              onChange={(event) => onCustomToChange(event.target.value)}
              className="h-8 w-36 text-xs"
              aria-label="Custom range end date"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={onApplyCustom}
            disabled={disabled || (!customFrom && !customTo)}
          >
            Apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}
