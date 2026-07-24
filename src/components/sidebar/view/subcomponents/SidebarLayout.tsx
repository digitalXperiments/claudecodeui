import { cn } from '../../../../lib/utils';

type SidebarLayoutProps = {
  isCollapsed: boolean;
  isMobile: boolean;
  mobileShowSessions: boolean;
  rail: React.ReactNode;
  projectsPanel: React.ReactNode;
  sessionsPanel: React.ReactNode;
};

export default function SidebarLayout({
  isCollapsed,
  isMobile,
  mobileShowSessions,
  rail,
  projectsPanel,
  sessionsPanel,
}: SidebarLayoutProps) {
  if (isCollapsed) {
    return <div className="flex h-full">{rail}</div>;
  }

  // Desktop: rail + projects + sessions column.
  if (!isMobile) {
    return (
      <div className="flex h-full">
        {rail}
        {projectsPanel}
        {sessionsPanel}
      </div>
    );
  }

  // Mobile drawer: rail + one panel at a time to stay within the drawer width.
  return (
    <div className="flex h-full">
      {rail}
      <div className={cn('flex h-full min-w-0 flex-1', mobileShowSessions && 'hidden md:flex')}>
        {projectsPanel}
      </div>
      {mobileShowSessions && <div className="flex h-full flex-1">{sessionsPanel}</div>}
    </div>
  );
}
