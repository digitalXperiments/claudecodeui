import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export default function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-border/70" role="tablist">
      {options.map((option) => <button key={option.value} type="button" role="tab" aria-selected={value === option.value} onClick={() => onChange(option.value)} className={cn('border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', value === option.value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{option.label}</button>)}
    </div>
  );
}

export function TabPanel({ children }: { children: ReactNode }) { return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>; }
