import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';

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
  onLoadMoreSessions?: (projectId: string) => void | Promise<void>;
  isLoadingMoreSessions?: boolean;
  className?: string;
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
  onLoadMoreSessions,
  isLoadingMoreSessions = false,
  className,
}: SessionSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => new Date());
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    setNow(new Date());
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    // Focus search after open for quick filter.
    requestAnimationFrame(() => searchRef.current?.focus());

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  const handleSelect = (session: SessionWithProvider) => {
    onSessionSelect(session);
    close();
  };

  const titleFallback = t('mainContent.newSession', { defaultValue: 'New Session' });
  const currentTitle = getSessionTitle(selectedSession, titleFallback);

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'group flex max-w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors',
          'hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
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

      {open && (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-background shadow-lg"
          role="listbox"
        >
          <div className="border-b border-border/60 p-2">
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
                className="h-9 rounded-lg border-0 bg-muted/50 pl-8 pr-8 text-sm focus-visible:ring-1"
                aria-label={t('sessions.searchPlaceholder', {
                  defaultValue: 'Search sessions…',
                })}
              />
              {query ? (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setQuery('')}
                  aria-label={t('tooltips.clearSearch', { defaultValue: 'Clear search' })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto overscroll-contain p-1.5">
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

                return (
                  <button
                    key={`${session.__provider}-${session.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-accent/70',
                    )}
                    onClick={() => handleSelect(session)}
                  >
                    <SessionProviderLogo
                      provider={session.__provider}
                      className="h-3.5 w-3.5 flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {view.sessionName}
                    </span>
                    {age ? (
                      <span
                        className={cn(
                          'flex-shrink-0 text-[11px]',
                          isActive ? 'text-primary/70' : 'text-muted-foreground',
                        )}
                      >
                        {age}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}

            {!query.trim() && hasMore && onLoadMoreSessions ? (
              <button
                type="button"
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground disabled:opacity-50"
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

        </div>
      )}
    </div>
  );
}
