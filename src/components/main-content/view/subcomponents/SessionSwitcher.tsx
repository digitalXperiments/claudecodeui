import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ChevronDown, Loader2, MoreHorizontal, Search, Trash2, X } from 'lucide-react';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { Input } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession } from '../../../../types/app';
import {
  createSessionViewModel,
  getAllSessions,
  getSessionName,
} from '../../../sidebar/utils/utils';
import type { SessionWithProvider } from '../../../sidebar/types/types';

type SessionSwitcherProps = {
  project: Project;
  selectedSession: ProjectSession | null;
  onSessionSelect: (session: ProjectSession) => void;
  onArchiveSession?: (session: ProjectSession) => void | Promise<void>;
  onDeleteSession?: (session: ProjectSession) => void | Promise<void>;
  onLoadMoreSessions?: (projectId: string) => void | Promise<void>;
  isLoadingMoreSessions?: boolean;
  /** When true, open as a bottom sheet so it stays usable on narrow viewports. */
  isMobile?: boolean;
  className?: string;
};

type SessionMenuPosition = {
  top: number;
  left: number;
  ready: boolean;
};

function formatCompactAge(dateString: string, now: Date): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
}

function getSessionTitle(session: ProjectSession | null, fallback: string): string {
  if (!session) {
    return fallback;
  }
  if (session.__provider === 'cursor') {
    return (session.name as string) || fallback;
  }
  return (session.summary as string) || (session.name as string) || fallback;
}

export default function SessionSwitcher({
  project,
  selectedSession,
  onSessionSelect,
  onArchiveSession,
  onDeleteSession,
  onLoadMoreSessions,
  isLoadingMoreSessions = false,
  isMobile = false,
  className,
}: SessionSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const [sessionMenuPosition, setSessionMenuPosition] = useState<SessionMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sessionMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const restoreSessionMenuFocusRef = useRef(false);
  const openMenuSessionIdRef = useRef<string | null>(null);
  const sessionMenuId = useId();
  const listboxId = useId();

  openMenuSessionIdRef.current = openMenuSessionId;

  // getAllSessions already sorts by recency (newest first).
  const sessions = useMemo(() => getAllSessions(project), [project]);
  const hasMore = Boolean(project.sessionMeta?.hasMore);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return sessions;
    }

    return sessions.filter((session) => {
      const name = getSessionName(session, t).toLowerCase();
      const provider = String(session.__provider || session.provider || '').toLowerCase();
      return name.includes(needle) || provider.includes(needle);
    });
  }, [query, sessions, t]);

  const closeSessionMenu = useCallback((restoreFocus = false) => {
    restoreSessionMenuFocusRef.current = restoreFocus;
    setOpenMenuSessionId(null);
    setSessionMenuPosition(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    closeSessionMenu();
  }, [closeSessionMenu]);

  const updateSessionMenuPosition = useCallback(() => {
    const button = sessionMenuButtonRef.current;
    const menu = sessionMenuRef.current;
    if (!button || !menu) {
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 6;
    const menuWidth = menuRect.width || 176;
    const menuHeight = menuRect.height || 80;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
    const left = Math.min(
      Math.max(viewportPadding, buttonRect.right - menuWidth),
      maxLeft,
    );
    const fitsBelow = buttonRect.bottom + gap + menuHeight <= window.innerHeight - viewportPadding;
    const fitsAbove = buttonRect.top - gap - menuHeight >= viewportPadding;
    const preferredTop = fitsBelow || !fitsAbove
      ? buttonRect.bottom + gap
      : buttonRect.top - gap - menuHeight;
    const maxTop = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding);
    const top = Math.min(Math.max(viewportPadding, preferredTop), maxTop);

    setSessionMenuPosition({ top, left, ready: true });
  }, []);

  const openSessionMenu = useCallback((sessionId: string, button: HTMLButtonElement) => {
    if (openMenuSessionId === sessionId) {
      closeSessionMenu();
      return;
    }

    restoreSessionMenuFocusRef.current = false;
    sessionMenuButtonRef.current = button;
    setSessionMenuPosition({ top: 0, left: 0, ready: false });
    setOpenMenuSessionId(sessionId);
  }, [closeSessionMenu, openMenuSessionId]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target)
        || panelRef.current?.contains(target)
        || sessionMenuRef.current?.contains(target)
      ) {
        return;
      }

      if (openMenuSessionId) {
        closeSessionMenu();
      } else {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (openMenuSessionId) {
          closeSessionMenu(true);
        } else {
          close();
        }
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, closeSessionMenu, open, openMenuSessionId]);

  // Lock body scroll while the mobile sheet is open.
  useEffect(() => {
    if (!open || !isMobile) {
      return undefined;
    }

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isMobile, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    setNow(new Date());
    const frame = requestAnimationFrame(() => {
      if (!openMenuSessionIdRef.current) {
        searchRef.current?.focus();
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!openMenuSessionId || !open) {
      setSessionMenuPosition(null);
      return undefined;
    }

    const update = () => updateSessionMenuPosition();
    const frame = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, openMenuSessionId, query, updateSessionMenuPosition]);

  useEffect(() => {
    if (openMenuSessionId && !filteredSessions.some((session) => session.id === openMenuSessionId)) {
      closeSessionMenu();
    }
  }, [closeSessionMenu, filteredSessions, openMenuSessionId]);

  useEffect(() => {
    if (!openMenuSessionId || !sessionMenuPosition?.ready) {
      return undefined;
    }

    const frame = requestAnimationFrame(() => {
      sessionMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [openMenuSessionId, sessionMenuPosition?.ready]);

  useEffect(() => {
    if (openMenuSessionId || !restoreSessionMenuFocusRef.current) {
      return;
    }

    restoreSessionMenuFocusRef.current = false;
    const frame = requestAnimationFrame(() => sessionMenuButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [openMenuSessionId]);

  const handleSelect = (session: SessionWithProvider) => {
    onSessionSelect(session);
    close();
  };

  const handleArchive = (session: SessionWithProvider) => {
    close();
    void onArchiveSession?.(session);
  };

  const handleDelete = (session: SessionWithProvider) => {
    const sessionName = getSessionName(session, t);
    const confirmed = window.confirm(
      t('sessions.deleteConfirm', {
        defaultValue: `Delete "${sessionName}" permanently? This cannot be undone.`,
        name: sessionName,
      }),
    );

    if (!confirmed) {
      return;
    }

    close();
    void onDeleteSession?.(session);
  };

  const titleFallback = t('mainContent.newSession', { defaultValue: 'New Session' });
  const currentTitle = getSessionTitle(selectedSession, titleFallback);
  const openMenuSession = openMenuSessionId
    ? filteredSessions.find((session) => session.id === openMenuSessionId)
    : null;

  const sessionList = (
    <>
      <div className="border-b border-border/60 p-2 sm:p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sessions.searchPlaceholder', {
              defaultValue: 'Search sessions…',
            })}
            className="h-10 rounded-lg border-0 bg-muted/50 pl-8 pr-8 text-base sm:h-9 sm:text-sm focus-visible:ring-1"
            aria-label={t('sessions.searchPlaceholder', {
              defaultValue: 'Search sessions…',
            })}
          />
          {query ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setQuery('')}
              aria-label={t('tooltips.clearSearch', { defaultValue: 'Clear search' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          'overflow-y-auto overscroll-contain p-1.5',
          isMobile ? 'max-h-[min(60dvh,28rem)]' : 'max-h-72',
        )}
      >
        {filteredSessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {query.trim()
              ? t('sessions.noSearchResults', { defaultValue: 'No sessions match your search' })
              : t('sessions.empty', { defaultValue: 'No sessions yet' })}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const view = createSessionViewModel(session, now, t);
            const isActive = selectedSession?.id === session.id;
            const age = formatCompactAge(view.sessionTime, now);
            const isMenuOpen = openMenuSessionId === session.id;
            const hasActions = Boolean(onArchiveSession || onDeleteSession);

            return (
              <div
                key={`${session.__provider}-${session.id}`}
                role="option"
                aria-selected={isActive}
                className={cn(
                  'group relative flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left transition-colors sm:gap-2 sm:px-2.5 sm:py-2',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-accent/70 active:bg-accent/70',
                )}
              >
                <button
                  type="button"
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-sm px-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:min-h-0"
                  onClick={() => handleSelect(session)}
                >
                  <SessionProviderLogo
                    provider={session.__provider}
                    className="h-3.5 w-3.5 flex-shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium sm:text-xs">
                    {view.sessionName}
                  </span>
                </button>
                {age ? (
                  <span
                    className={cn(
                      'flex-shrink-0 text-[11px] transition-opacity',
                      isActive ? 'text-primary/70' : 'text-muted-foreground',
                      // Hide age only when a fine pointer can reveal the action button on hover.
                      hasActions && '[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-0',
                    )}
                  >
                    {age}
                  </span>
                ) : null}
                {hasActions ? (
                  <div className="relative flex-shrink-0">
                    <button
                      type="button"
                      className={cn(
                        'flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors sm:h-6 sm:w-6',
                        'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
                        // Always visible on touch / coarse pointers; hover-reveal on desktop.
                        'opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100',
                        isMenuOpen && 'bg-accent text-foreground opacity-100',
                      )}
                      aria-label={t('sessions.actions', { defaultValue: 'Session actions' })}
                      aria-haspopup="menu"
                      aria-expanded={isMenuOpen}
                      aria-controls={isMenuOpen ? sessionMenuId : undefined}
                      ref={(button) => {
                        if (isMenuOpen) {
                          sessionMenuButtonRef.current = button;
                        }
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        openSessionMenu(session.id, event.currentTarget);
                      }}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        {!query.trim() && hasMore && onLoadMoreSessions ? (
          <button
            type="button"
            className="mt-1 flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground disabled:opacity-50 sm:min-h-0"
            disabled={isLoadingMoreSessions}
            onClick={() => void onLoadMoreSessions(project.projectId)}
          >
            {isLoadingMoreSessions ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('sessions.loadingMore', { defaultValue: 'Loading…' })}
              </>
            ) : (
              t('sessions.loadMore', { defaultValue: 'Load more sessions' })
            )}
          </button>
        ) : null}
      </div>
    </>
  );

  const dropdownPanel = open && !isMobile ? (
    <div
      ref={panelRef}
      id={listboxId}
      className="absolute left-0 top-[calc(100%+6px)] z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-background shadow-lg"
      role="listbox"
      aria-label={t('sessions.switchSession', { defaultValue: 'Switch session' })}
    >
      {sessionList}
    </div>
  ) : null;

  const mobileSheet = open && isMobile && typeof document !== 'undefined'
    ? createPortal(
        <div className="fixed inset-0 z-[80] flex flex-col justify-end" role="presentation">
          <button
            type="button"
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            aria-label={t('common.close', { defaultValue: 'Close' })}
            onClick={close}
          />
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            aria-label={t('sessions.switchSession', { defaultValue: 'Switch session' })}
            className="relative z-10 flex max-h-[min(85dvh,40rem)] w-full flex-col overflow-hidden rounded-t-2xl border border-border/70 bg-background shadow-2xl"
            style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}
          >
            <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">
                  {t('sessions.switchSession', { defaultValue: 'Switch session' })}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {project.displayName}
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={t('common.close', { defaultValue: 'Close' })}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {sessionList}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          'group flex max-w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors sm:py-1',
          'hover:bg-accent/70 active:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          // Comfortable tap target on mobile without bloating desktop.
          'min-h-10 sm:min-h-0',
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        title={currentTitle}
      >
        {selectedSession && (
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <SessionProviderLogo provider={selectedSession.__provider} className="h-4 w-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold leading-tight text-foreground">
              {currentTitle}
            </span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </span>
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">
            {project.displayName}
          </span>
        </span>
      </button>

      {dropdownPanel}
      {mobileSheet}

      {open && openMenuSession && sessionMenuPosition && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={sessionMenuRef}
              id={sessionMenuId}
              role="menu"
              tabIndex={-1}
              aria-label={t('sessions.actions', { defaultValue: 'Session actions' })}
              className="animate-in fade-in-0 zoom-in-95 fixed z-[100] max-h-[calc(100vh-1rem)] min-w-[10.5rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border/80 bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-black/5 dark:ring-white/10"
              style={{
                top: sessionMenuPosition.top,
                left: sessionMenuPosition.left,
                visibility: sessionMenuPosition.ready ? 'visible' : 'hidden',
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {onArchiveSession ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] leading-none text-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:min-h-8"
                  onClick={() => handleArchive(openMenuSession)}
                >
                  <Archive className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="font-medium tracking-tight">
                    {t('sessions.archive', { defaultValue: 'Archive' })}
                  </span>
                </button>
              ) : null}
              {onDeleteSession ? (
                <>
                  {onArchiveSession ? <div className="mx-1 my-1 h-px bg-border/60" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] leading-none text-red-600 transition-colors hover:bg-red-50 focus-visible:bg-red-50 focus-visible:outline-none dark:text-red-400 dark:hover:bg-red-950/40 dark:focus-visible:bg-red-950/40 sm:min-h-8"
                    onClick={() => handleDelete(openMenuSession)}
                  >
                    <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="font-medium tracking-tight">
                      {t('sessions.delete', { defaultValue: 'Delete permanently' })}
                    </span>
                  </button>
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
