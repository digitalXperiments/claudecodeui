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
  onArchiveSession,
  onDeleteSession,
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
  }, [updateScrollState, isMobile, shouldShowTasksTab, shouldShowBrowserTab]);

  const titleBlock = isChatTab ? (
    <SessionSwitcher
      project={selectedProject}
      selectedSession={selectedSession}
      onSessionSelect={onSessionSelect}
      onArchiveSession={onArchiveSession}
      onDeleteSession={onDeleteSession}
      onLoadMoreSessions={onLoadMoreSessions}
      isLoadingMoreSessions={isLoadingMoreSessions}
      isMobile={isMobile}
      className="min-w-0 flex-1"
    />
  ) : (
    <MainContentTitle
      activeTab={activeTab}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      shouldShowTasksTab={shouldShowTasksTab}
    />
  );

  const newSessionButton = isChatTab ? (
    <Button
      variant="default"
      size="sm"
      className="h-9 w-9 flex-shrink-0 gap-1.5 p-0 text-xs font-medium sm:h-8 sm:w-auto sm:px-3"
      onClick={() => onNewSession(selectedProject)}
      title={t('sessions.newSession', { defaultValue: 'New Session' })}
      aria-label={t('sessions.newSession', { defaultValue: 'New Session' })}
    >
      <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
      <span className="hidden sm:inline">
        {t('sessions.newSession', { defaultValue: 'New Session' })}
      </span>
    </Button>
  ) : null;

  const tabScroller = (
    <div className="relative min-w-0 flex-1 overflow-hidden sm:flex-initial">
      {canScrollLeft && (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
      )}
      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className="scrollbar-hide overflow-x-auto overscroll-x-contain"
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
  );

  // Mobile: two rows so the session switcher stays tappable and tabs don't
  // crush it. Desktop keeps the compact single-row header.
  if (isMobile) {
    return (
      <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <MobileMenuButton onMenuClick={onMenuClick} />
          {titleBlock}
          {newSessionButton}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center">{tabScroller}</div>
      </div>
    );
  }

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">{titleBlock}</div>

        <div className="flex min-w-0 flex-shrink items-center gap-2 sm:flex-shrink-0">
          {tabScroller}
          {newSessionButton}
        </div>
      </div>
    </div>
  );
}
