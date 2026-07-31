import type { TFunction } from 'i18next';

import type { LLMProvider, Project, ProjectCategory, ProjectSession } from '../../../types/app';
import type { ProjectCategoryGroup, ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider } from '../types/types';

// Native HTML5 drag-and-drop payloads used to drag projects onto category
// headers (assignment) and category headers onto each other (reordering).
export const PROJECT_DRAG_MIME = 'application/x-cloudcli-project-id';
export const CATEGORY_DRAG_MIME = 'application/x-cloudcli-category-id';

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  return (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

export const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

/**
 * Buckets an already-sorted project list into category groups for sidebar
 * rendering. Category order follows `categories` (server `sortOrder`);
 * projects keep their incoming (sorted) order inside each group. Projects
 * pointing at an unknown category fall back to "Uncategorized" (the
 * `category: null` group), which is always rendered last. Empty categories
 * are kept unless `hideEmpty` is set (active search/running views), so users
 * still have drop targets when dragging projects into a fresh category.
 */
export const groupProjectsByCategory = (
  projects: Project[],
  categories: ProjectCategory[],
  { hideEmpty = false }: { hideEmpty?: boolean } = {},
): ProjectCategoryGroup[] => {
  const knownCategoryIds = new Set(categories.map((category) => category.categoryId));
  const projectsByCategoryId = new Map<string | null, Project[]>();

  for (const project of projects) {
    const categoryId =
      typeof project.categoryId === 'string' && knownCategoryIds.has(project.categoryId)
        ? project.categoryId
        : null;
    const bucket = projectsByCategoryId.get(categoryId) ?? [];
    bucket.push(project);
    projectsByCategoryId.set(categoryId, bucket);
  }

  const groups: ProjectCategoryGroup[] = [];
  for (const category of categories) {
    const categoryProjects = projectsByCategoryId.get(category.categoryId) ?? [];
    if (hideEmpty && categoryProjects.length === 0) {
      continue;
    }
    groups.push({ category, projects: categoryProjects });
  }

  const uncategorizedProjects = projectsByCategoryId.get(null) ?? [];
  if (uncategorizedProjects.length > 0) {
    groups.push({ category: null, projects: uncategorizedProjects });
  }

  return groups;
};

const COLLAPSED_CATEGORIES_STORAGE_KEY = 'sidebarCollapsedCategories';

/** Pseudo-id for the implicit Uncategorized group in the projects sidebar. */
export const UNCATEGORIZED_CATEGORY_KEY = 'uncategorized';

/**
 * Reads collapsed sidebar category ids from localStorage. The pseudo-id
 * 'uncategorized' covers the uncategorized group.
 */
export const readCollapsedCategoryIds = (): string[] => {
  try {
    const saved = localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

export const writeCollapsedCategoryIds = (categoryIds: string[]) => {
  try {
    localStorage.setItem(COLLAPSED_CATEGORIES_STORAGE_KEY, JSON.stringify(categoryIds));
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

/**
 * All category keys currently rendered in the projects sidebar (real categories
 * plus the implicit uncategorized bucket).
 */
export const getSidebarCategoryKeys = (categories: ProjectCategory[]): string[] => [
  ...categories.map((category) => category.categoryId),
  UNCATEGORIZED_CATEGORY_KEY,
];

/**
 * Accordion helper: at most one category may be expanded. Returns the collapsed
 * set that keeps `expandedCategoryKey` open (or collapses everything when null).
 */
export const buildAccordionCollapsedCategoryIds = (
  allCategoryKeys: string[],
  expandedCategoryKey: string | null,
): Set<string> => {
  if (!expandedCategoryKey) {
    return new Set(allCategoryKeys);
  }

  return new Set(allCategoryKeys.filter((key) => key !== expandedCategoryKey));
};

/**
 * If more than one category is expanded, keep the first expanded key (in
 * sidebar order) and collapse the rest. No-op when already accordion-valid.
 */
export const enforceSingleExpandedCategory = (
  collapsedCategoryIds: Set<string>,
  allCategoryKeys: string[],
): Set<string> => {
  if (allCategoryKeys.length === 0) {
    return collapsedCategoryIds;
  }

  const expandedKeys = allCategoryKeys.filter((key) => !collapsedCategoryIds.has(key));
  if (expandedKeys.length <= 1) {
    // Still ensure known keys that should be collapsed are present (e.g. after
    // new categories appear while another is open).
    if (expandedKeys.length === 1) {
      const next = buildAccordionCollapsedCategoryIds(allCategoryKeys, expandedKeys[0]);
      if (
        next.size === collapsedCategoryIds.size &&
        [...next].every((key) => collapsedCategoryIds.has(key))
      ) {
        return collapsedCategoryIds;
      }
      return next;
    }
    // Zero expanded: collapse any newly-seen keys so they stay closed.
    const next = new Set(collapsedCategoryIds);
    let changed = false;
    for (const key of allCategoryKeys) {
      if (!next.has(key)) {
        next.add(key);
        changed = true;
      }
    }
    return changed ? next : collapsedCategoryIds;
  }

  return buildAccordionCollapsedCategoryIds(allCategoryKeys, expandedKeys[0]);
};

const PROJECTS_PANEL_COLLAPSED_STORAGE_KEY = 'sidebarProjectsPanelCollapsed';

/** Whether the Projects column is collapsed (desktop focus mode). */
export const readProjectsPanelCollapsed = (): boolean => {
  try {
    return localStorage.getItem(PROJECTS_PANEL_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const writeProjectsPanelCollapsed = (collapsed: boolean) => {
  try {
    localStorage.setItem(PROJECTS_PANEL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
