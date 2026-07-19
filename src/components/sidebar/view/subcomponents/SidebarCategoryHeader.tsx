import { useState, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, Edit3, Folder, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { ProjectCategory } from '../../../../types/app';
import { CATEGORY_DRAG_MIME, PROJECT_DRAG_MIME } from '../../utils/utils';

export const UNCATEGORIZED_CATEGORY_KEY = 'uncategorized';

type SidebarCategoryHeaderProps = {
  // `null` renders the implicit "Uncategorized" group: it accepts project
  // drops (clearing the assignment) but cannot be edited, deleted or dragged.
  category: ProjectCategory | null;
  projectCount: number;
  isCollapsed: boolean;
  onToggle: (categoryKey: string) => void;
  onEditCategory: (category: ProjectCategory) => void;
  onDeleteCategory: (category: ProjectCategory) => void;
  onDropProject: (projectId: string, categoryId: string | null) => void;
  onReorderCategory: (draggedCategoryId: string, targetCategoryId: string) => void;
  t: TFunction;
};

export default function SidebarCategoryHeader({
  category,
  projectCount,
  isCollapsed,
  onToggle,
  onEditCategory,
  onDeleteCategory,
  onDropProject,
  onReorderCategory,
  t,
}: SidebarCategoryHeaderProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const categoryKey = category?.categoryId ?? UNCATEGORIZED_CATEGORY_KEY;
  const label = category?.name ?? t('categories.uncategorized', 'Uncategorized');

  const acceptsPayload = (event: DragEvent<HTMLDivElement>): boolean => {
    const types = event.dataTransfer.types;
    if (types.includes(PROJECT_DRAG_MIME)) {
      return true;
    }
    // Category headers can be reordered by dragging them onto each other;
    // the uncategorized group is pinned last and is not a reorder target.
    return category !== null && types.includes(CATEGORY_DRAG_MIME);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!acceptsPayload(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsDragOver(false);
    if (!acceptsPayload(event)) {
      return;
    }
    event.preventDefault();

    const draggedProjectId = event.dataTransfer.getData(PROJECT_DRAG_MIME);
    if (draggedProjectId) {
      onDropProject(draggedProjectId, category?.categoryId ?? null);
      return;
    }

    const draggedCategoryId = event.dataTransfer.getData(CATEGORY_DRAG_MIME);
    if (draggedCategoryId && category) {
      onReorderCategory(draggedCategoryId, category.categoryId);
    }
  };

  return (
    <div
      className={cn(
        'group mx-3 flex items-center gap-2 rounded-lg px-2 py-2 transition-colors md:mx-1 md:px-1.5 md:py-1',
        isDragOver && 'bg-primary/5 ring-1 ring-primary/40',
      )}
      draggable={category !== null}
      onDragStart={(event) => {
        if (!category) {
          return;
        }
        event.dataTransfer.setData(CATEGORY_DRAG_MIME, category.categoryId);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => onToggle(categoryKey)}
        title={label}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        )}
        {category?.color ? (
          <span
            className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
            style={{ backgroundColor: category.color }}
          />
        ) : (
          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
          {projectCount}
        </span>
      </button>

      {category && (
        <div className="flex flex-shrink-0 items-center gap-1 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onEditCategory(category);
            }}
            title={t('tooltips.editCategory', 'Edit category')}
          >
            <Edit3 className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteCategory(category);
            }}
            title={t('tooltips.deleteCategory', 'Delete category')}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
