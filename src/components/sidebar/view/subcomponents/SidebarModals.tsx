import { useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, Check, EyeOff, Folder, FolderPlus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../../shared/view/ui';
import Settings from '../../../settings/view/Settings';
import VersionUpgradeModal from '../../../version-upgrade/view';
import type { Project, ProjectCategory } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { InstallMode } from '../../../../hooks/useVersionCheck';
import { normalizeProjectForSettings } from '../../utils/utils';
import type {
  CategoryEditorState,
  DeleteCategoryConfirmation,
  DeleteProjectConfirmation,
  SessionDeleteConfirmation,
  SettingsProject,
} from '../../types/types';
import ProjectCreationWizard from '../../../project-creation-wizard';

// Preset palette offered in the category editor (stored as hex in the DB).
const CATEGORY_COLOR_PRESETS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showNewProject: boolean;
  onCloseNewProject: () => void;
  onProjectCreated: () => void;
  deleteConfirmation: DeleteProjectConfirmation | null;
  onCancelDeleteProject: () => void;
  onConfirmDeleteProject: (deleteData?: boolean) => void;
  sessionDeleteConfirmation: SessionDeleteConfirmation | null;
  onCancelDeleteSession: () => void;
  onConfirmDeleteSession: (hardDelete?: boolean) => void;
  categories: ProjectCategory[];
  categoryEditor: CategoryEditorState | null;
  onCloseCategoryEditor: () => void;
  onSaveCategory: (name: string, color: string | null) => Promise<string | null>;
  categoryDeleteConfirmation: DeleteCategoryConfirmation | null;
  onCancelDeleteCategory: () => void;
  onConfirmDeleteCategory: () => void;
  moveToCategoryProject: Project | null;
  onCloseMoveToCategory: () => void;
  onAssignProjectToCategory: (projectId: string, categoryId: string | null) => void;
  onCreateCategoryFromMove: () => void;
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  releaseInfo: ReleaseInfo | null;
  currentVersion: string;
  latestVersion: string | null;
  installMode: InstallMode;
  t: TFunction;
};

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent = Settings as (props: TypedSettingsProps) => JSX.Element;

function TypedSettings(props: TypedSettingsProps) {
  return <SettingsComponent {...props} />;
}

type CategoryEditorModalProps = {
  editor: CategoryEditorState;
  onClose: () => void;
  // Returns null on success or an error message to display inline.
  onSave: (name: string, color: string | null) => Promise<string | null>;
  t: TFunction;
};

function CategoryEditorModal({ editor, onClose, onSave, t }: CategoryEditorModalProps) {
  const [name, setName] = useState(editor.mode === 'edit' ? editor.category.name : '');
  const [color, setColor] = useState<string | null>(
    editor.mode === 'edit' ? editor.category.color : null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage(t('categories.nameRequired', 'Enter a category name.'));
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    const saveError = await onSave(trimmedName, color);
    setIsSaving(false);
    if (saveError) {
      setErrorMessage(saveError);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-foreground">
            {editor.mode === 'create'
              ? t('categories.newCategory', 'New category')
              : t('categories.editCategory', 'Edit category')}
          </h3>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="category-name-input">
            {t('categories.nameLabel', 'Name')}
          </label>
          <input
            id="category-name-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            placeholder={t('categories.namePlaceholder', 'Category name')}
            autoFocus
            maxLength={60}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleSave();
              }
              if (event.key === 'Escape') {
                onClose();
              }
            }}
          />
          <label className="mb-1 mt-4 block text-xs font-medium text-muted-foreground">
            {t('categories.colorLabel', 'Color')}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`flex h-7 w-7 items-center justify-center rounded-full border transition-all ${
                color === null
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'border-border hover:border-foreground/40'
              }`}
              onClick={() => setColor(null)}
              title={t('categories.noColor', 'No color')}
            >
              <span className="block h-4 w-px rotate-45 bg-muted-foreground/60" />
            </button>
            {CATEGORY_COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`h-7 w-7 rounded-full border transition-all ${
                  color === preset
                    ? 'border-foreground ring-2 ring-foreground/20'
                    : 'border-transparent hover:scale-110'
                }`}
                style={{ backgroundColor: preset }}
                onClick={() => setColor(preset)}
                title={preset}
              />
            ))}
          </div>
          {errorMessage && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
          )}
        </div>
        <div className="flex gap-2 border-t border-border bg-muted/30 p-4">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={isSaving}>
            {t('actions.cancel')}
          </Button>
          <Button className="flex-1" onClick={() => void handleSave()} disabled={isSaving}>
            {editor.mode === 'create'
              ? t('categories.createAction', 'Create category')
              : t('actions.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type MoveToCategoryModalProps = {
  project: Project;
  categories: ProjectCategory[];
  onAssign: (categoryId: string | null) => void;
  onCreateNew: () => void;
  onClose: () => void;
  t: TFunction;
};

function MoveToCategoryModal({ project, categories, onAssign, onCreateNew, onClose, t }: MoveToCategoryModalProps) {
  const currentCategoryId = project.categoryId ?? null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="p-6 pb-3">
          <h3 className="mb-1 text-lg font-semibold text-foreground">
            {t('categories.moveToCategory', 'Move to category')}
          </h3>
          <p className="truncate text-sm text-muted-foreground">{project.displayName}</p>
        </div>
        <div className="max-h-72 overflow-y-auto px-3 pb-3">
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
            onClick={() => onAssign(null)}
          >
            <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {t('categories.uncategorized', 'Uncategorized')}
            </span>
            {currentCategoryId === null && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
          </button>
          {categories.map((category) => (
            <button
              key={category.categoryId}
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
              onClick={() => onAssign(category.categoryId)}
            >
              {category.color ? (
                <span
                  className="h-3 w-3 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: category.color }}
                />
              ) : (
                <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground">{category.name}</span>
              {currentCategoryId === category.categoryId && (
                <Check className="h-4 w-4 flex-shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
        <div className="flex gap-2 border-t border-border bg-muted/30 p-4">
          <Button variant="outline" className="flex-1 justify-start" onClick={onCreateNew}>
            <FolderPlus className="mr-2 h-4 w-4" />
            {t('categories.newCategory', 'New category')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function SidebarModals({
  projects,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showNewProject,
  onCloseNewProject,
  onProjectCreated,
  deleteConfirmation,
  onCancelDeleteProject,
  onConfirmDeleteProject,
  sessionDeleteConfirmation,
  onCancelDeleteSession,
  onConfirmDeleteSession,
  categories,
  categoryEditor,
  onCloseCategoryEditor,
  onSaveCategory,
  categoryDeleteConfirmation,
  onCancelDeleteCategory,
  onConfirmDeleteCategory,
  moveToCategoryProject,
  onCloseMoveToCategory,
  onAssignProjectToCategory,
  onCreateCategoryFromMove,
  showVersionModal,
  onCloseVersionModal,
  releaseInfo,
  currentVersion,
  latestVersion,
  installMode,
  t,
}: SidebarModalsProps) {
  // Settings expects project identity/path fields to be present for dropdown labels and local-scope MCP config.
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  return (
    <>
      {showNewProject &&
        ReactDOM.createPortal(
          <ProjectCreationWizard
            onClose={onCloseNewProject}
            onProjectCreated={onProjectCreated}
          />,
          document.body,
        )}

      {showSettings &&
        ReactDOM.createPortal(
          <TypedSettings
            isOpen={showSettings}
            onClose={onCloseSettings}
            projects={settingsProjects}
            initialTab={settingsInitialTab}
          />,
          document.body,
        )}

      {deleteConfirmation &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/30">
                    <AlertTriangle className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteProject')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {deleteConfirmation.project.displayName || deleteConfirmation.project.projectId}
                      </span>
                      ?
                    </p>
                    {deleteConfirmation.sessionCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('deleteConfirmation.sessionCount', { count: deleteConfirmation.sessionCount })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onConfirmDeleteProject(false)}
                >
                  <EyeOff className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.archiveProject', 'Archive project')}
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteProject(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteAllData')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeleteProject}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {sessionDeleteConfirmation &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                    <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteSession')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {sessionDeleteConfirmation.sessionTitle || t('sessions.unnamed')}
                      </span>
                      ?
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {sessionDeleteConfirmation.isArchived
                        ? t('deleteConfirmation.archivedSessionNotice', 'This session is already archived. You can keep it hidden or delete it permanently.')
                        : t('deleteConfirmation.archiveSessionNotice', 'Archive keeps the session out of the active list while preserving its history.')}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                {!sessionDeleteConfirmation.isArchived && (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onConfirmDeleteSession(false)}
                  >
                    <EyeOff className="mr-2 h-4 w-4" />
                    {t('deleteConfirmation.archiveSession', 'Archive session')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteSession(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeleteSession}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {moveToCategoryProject && (
        <MoveToCategoryModal
          project={moveToCategoryProject}
          categories={categories}
          onAssign={(categoryId) => onAssignProjectToCategory(moveToCategoryProject.projectId, categoryId)}
          onCreateNew={onCreateCategoryFromMove}
          onClose={onCloseMoveToCategory}
          t={t}
        />
      )}

      {categoryEditor && (
        // Key resets the form state when switching between create/edit targets.
        <CategoryEditorModal
          key={categoryEditor.mode === 'edit' ? categoryEditor.category.categoryId : 'create'}
          editor={categoryEditor}
          onClose={onCloseCategoryEditor}
          onSave={onSaveCategory}
          t={t}
        />
      )}

      {categoryDeleteConfirmation &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                    <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('categories.deleteTitle', 'Delete category')}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t(
                        'categories.deleteMessage',
                        'Delete "{{name}}"? Projects in this category will become uncategorized.',
                        { name: categoryDeleteConfirmation.category.name },
                      )}
                    </p>
                    {categoryDeleteConfirmation.projectCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('categories.deleteProjectCount', {
                          count: categoryDeleteConfirmation.projectCount,
                          defaultValue:
                            categoryDeleteConfirmation.projectCount === 1
                              ? 'This category contains {{count}} project.'
                              : 'This category contains {{count}} projects.',
                        })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={onConfirmDeleteCategory}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('categories.deleteAction', 'Delete category')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeleteCategory}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <VersionUpgradeModal
        isOpen={showVersionModal}
        onClose={onCloseVersionModal}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
      />
    </>
  );
}
