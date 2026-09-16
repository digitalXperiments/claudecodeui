import { useId } from 'react';

import { cn } from '../../../lib/utils';

export default function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  const id = useId();
  return (
    <div className="flex min-h-10 shrink-0 gap-1 overflow-x-auto border-b border-border/70 py-1" role="tablist" aria-label="Bot detail tabs">
      {options.map((option) => <button key={option.value} id={`${id}-${option.value}`} type="button" role="tab" tabIndex={value === option.value ? 0 : -1} aria-selected={value === option.value} onClick={() => onChange(option.value)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); const next = options[(options.findIndex((entry) => entry.value === option.value) + 1) % options.length]; onChange(next.value); } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); const next = options[(options.findIndex((entry) => entry.value === option.value) - 1 + options.length) % options.length]; onChange(next.value); } }} className={cn('shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', value === option.value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{option.label}</button>)}
    </div>
  );
}
