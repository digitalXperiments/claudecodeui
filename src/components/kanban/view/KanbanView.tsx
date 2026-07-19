import { SquareKanban } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../../types/app';

type KanbanViewProps = {
  selectedProject: Project | null;
  isVisible: boolean;
};

/**
 * Kanban orchestration board. Phase 0 renders a placeholder so the tab is wired
 * end-to-end; the real board (columns, task cards, drag-drop) arrives in Phase 2.
 */
export default function KanbanView({ selectedProject, isVisible }: KanbanViewProps) {
  const { t } = useTranslation();

  if (!isVisible) {
    return null;
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <SquareKanban className="h-10 w-10 opacity-60" />
      <div className="text-sm">
        {selectedProject
          ? t('kanban.placeholder', 'Kanban board for {{project}} — coming soon.', {
              project: selectedProject.displayName,
            })
          : t('kanban.noProject', 'Select a project to open its Kanban board.')}
      </div>
    </div>
  );
}
