import * as React from 'react';

import { cn } from '../../../lib/utils';

interface CollapsibleContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

function useCollapsible() {
  const ctx = React.useContext(CollapsibleContext);
  if (!ctx) throw new Error('Collapsible components must be used within <Collapsible>');
  return ctx;
}

interface CollapsibleProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(
  ({ defaultOpen = false, open: controlledOpen, onOpenChange: controlledOnOpenChange, className, children, ...props }, ref) => {
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : internalOpen;
    const onOpenChange = React.useCallback(
      (next: boolean) => {
        if (!isControlled) setInternalOpen(next);
        controlledOnOpenChange?.(next);
      },
      [isControlled, controlledOnOpenChange]
    );

    const value = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);

    return (
      <CollapsibleContext.Provider value={value}>
        <div ref={ref} data-state={open ? 'open' : 'closed'} className={className} {...props}>
          {children}
        </div>
      </CollapsibleContext.Provider>
    );
  }
);
Collapsible.displayName = 'Collapsible';

const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ onClick, children, className, ...props }, ref) => {
    const { open, onOpenChange } = useCollapsible();

    const handleClick = React.useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        onOpenChange(!open);
        onClick?.(e);
      },
      [open, onOpenChange, onClick]
    );

    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        data-state={open ? 'open' : 'closed'}
        onClick={handleClick}
        className={className}
        {...props}
      >
        {children}
      </button>
    );
  }
);
CollapsibleTrigger.displayName = 'CollapsibleTrigger';

const CollapsibleContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const { open } = useCollapsible();
    // Children mount on first open and then stay mounted, so the close
    // animation still has content to collapse and re-opening keeps state.
    // Previously every collapsed section (tool output, diffs, reasoning,
    // subagent logs) rendered its full subtree hidden behind a 0fr row.
    const [hasOpened, setHasOpened] = React.useState(open);
    if (open && !hasOpened) {
      setHasOpened(true);
    }

    return (
      <div
        ref={ref}
        data-state={open ? 'open' : 'closed'}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          className
        )}
        {...props}
      >
        <div className="overflow-hidden">
          {open || hasOpened ? children : null}
        </div>
      </div>
    );
  }
);
CollapsibleContent.displayName = 'CollapsibleContent';

export { Collapsible, CollapsibleTrigger, CollapsibleContent, useCollapsible };
