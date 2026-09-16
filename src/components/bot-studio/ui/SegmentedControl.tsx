import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

export type Segment<T extends string> = { value: T; label: ReactNode; count?: number };

export default function SegmentedControl<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<Segment<T>>;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-background p-0.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn('shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', value === option.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
          {option.label}{typeof option.count === 'number' ? <span className="ml-1 text-[10px] opacity-70">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
