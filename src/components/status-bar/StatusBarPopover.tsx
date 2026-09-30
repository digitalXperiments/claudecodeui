import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export interface StatusBarPopoverProps {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  delay?: number;
}

export default function StatusBarPopover({
  children,
  content,
  className = '',
  delay = 150,
}: StatusBarPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const enterTimeoutRef = useRef<number | null>(null);
  const leaveTimeoutRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; arrowLeft: number } | null>(null);

  const clearTimers = () => {
    if (enterTimeoutRef.current !== null) {
      window.clearTimeout(enterTimeoutRef.current);
      enterTimeoutRef.current = null;
    }
    if (leaveTimeoutRef.current !== null) {
      window.clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
  };

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const popoverWidth = popoverRef.current?.offsetWidth || 288;
    const spacing = 8;

    // Anchor bottom of popover above top of trigger
    const top = rect.top - spacing;

    // Center popover horizontally relative to trigger, but keep inside window bounds
    const triggerCenter = rect.left + rect.width / 2;
    const minLeft = 12;
    const maxLeft = Math.max(minLeft, window.innerWidth - popoverWidth - 12);
    const idealLeft = triggerCenter - popoverWidth / 2;
    const clampedLeft = Math.min(Math.max(idealLeft, minLeft), maxLeft);

    // Arrow relative to the popover
    const arrowLeft = Math.max(12, Math.min(popoverWidth - 12, triggerCenter - clampedLeft));

    setPosition({ top, left: clampedLeft, arrowLeft });
  }, []);

  const handleMouseEnter = () => {
    clearTimers();
    enterTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    clearTimers();
    leaveTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(false);
    }, 200);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimers();
    setIsOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }

    // Measure right away
    updatePosition();
    const rafId = window.requestAnimationFrame(updatePosition);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    const handlePointerDownOutside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleResize = () => updatePosition();

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDownOutside, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    return () => clearTimers();
  }, []);

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    >
      {children}

      {isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="tooltip"
            style={
              position
                ? {
                    position: 'fixed',
                    top: `${position.top}px`,
                    left: `${position.left}px`,
                    transform: 'translateY(-100%)',
                    zIndex: 10000,
                  }
                : {
                    position: 'fixed',
                    top: '-9999px',
                    left: '-9999px',
                    opacity: 0,
                    zIndex: 10000,
                  }
            }
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'animate-in fade-in-0 zoom-in-95 duration-150',
              'rounded-xl border border-border/80 bg-popover text-popover-foreground shadow-2xl backdrop-blur-md',
              'ring-1 ring-black/5 dark:ring-white/10 select-text cursor-default',
              className,
            )}
          >
            {content}

            {/* Downward-pointing arrow centered on trigger */}
            {position && (
              <span
                className="absolute top-full -translate-x-1/2 border-x-[5px] border-t-[5px] border-b-0 border-x-transparent border-t-border/80"
                style={{ left: `${position.arrowLeft}px` }}
              >
                <span
                  className="absolute -top-[5px] -left-[4px] border-x-[4px] border-t-[4px] border-b-0 border-x-transparent border-t-popover"
                />
              </span>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
