import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_IDLE_MS = 140;

/**
 * While a list is scrolling, hover targets flash as rows pass under a
 * stationary cursor. Returning `isScrolling` lets the list disable
 * pointer-events until the wheel/trackpad settles.
 */
export function useScrollPointerLock(idleMs = DEFAULT_IDLE_MS) {
  const [isScrolling, setIsScrolling] = useState(false);
  const timerRef = useRef<number>(0);

  const onScroll = useCallback(() => {
    setIsScrolling((wasScrolling) => (wasScrolling ? wasScrolling : true));
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setIsScrolling(false);
    }, idleMs);
  }, [idleMs]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { isScrolling, onScroll };
}
