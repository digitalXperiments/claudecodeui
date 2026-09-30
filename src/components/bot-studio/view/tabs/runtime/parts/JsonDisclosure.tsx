import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../../../../../lib/utils';

import { prettyJson } from './episodes';

/** Collapsible, redacted JSON view. The body is only rendered once opened. */
export default function JsonDisclosure({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[11px] leading-5 text-foreground">{prettyJson(value)}</pre>
      ) : null}
    </div>
  );
}
