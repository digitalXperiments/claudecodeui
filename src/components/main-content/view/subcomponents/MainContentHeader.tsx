import { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import type { MainContentHeaderProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import SessionSwitcher from './SessionSwitcher';

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onSessionSelect,
  onNewSession,
  onLoadMoreSessions,
  isLoadingMoreSessions = false,
}: MainContentHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const isChatTab = activeTab === 'chat';

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          {isChatTab ? (
            <SessionSwitcher
              project={selectedProject}
              selectedSession={selectedSession}
              onSessionSelect={onSessionSelect}
              onLoadMoreSessions={onLoadMoreSessions}
              isLoadingMoreSessions={isLoadingMoreSessions}
              className="min-w-0 flex-1"
            />
          ) : (
            <MainContentTitle
              activeTab={activeTab}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              shouldShowTasksTab={shouldShowTasksTab}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-shrink items-center gap-2 sm:flex-shrink-0">
          <div className="relative min-w-0 overflow-hidden">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className="scrollbar-hide overflow-x-auto"
            >
              <MainContentTabSwitcher
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
                shouldShowBrowserTab={shouldShowBrowserTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
            )}
          </div>

          {isChatTab && (
            <Button
              variant="default"
              size="sm"
              className="h-8 flex-shrink-0 gap-1.5 px-2.5 text-xs font-medium sm:px-3"
              onClick={() => onNewSession(selectedProject)}
              title={t('sessions.newSession', { defaultValue: 'New Session' })}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">
                {t('sessions.newSession', { defaultValue: 'New Session' })}
              </span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
