import { categoriesDb, projectsDb } from '@/modules/database/index.js';
import type { CategoryRepositoryRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type CategoryApiView = {
  categoryId: string;
  name: string;
  color: string | null;
  sortOrder: number;
};

type SetProjectCategoryResult = {
  categoryId: string | null;
};

const CATEGORY_NAME_MAX_LENGTH = 60;
const CATEGORY_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function mapCategoryRow(row: CategoryRepositoryRow): CategoryApiView {
  return {
    categoryId: row.category_id,
    name: row.name,
    color: row.color ?? null,
    sortOrder: row.sort_order,
  };
}

function normalizeCategoryName(nameInput: unknown): string {
  const name = typeof nameInput === 'string' ? nameInput.trim() : '';
  if (name.length < 1 || name.length > CATEGORY_NAME_MAX_LENGTH) {
    throw new AppError('Category name is required and must be 1-60 characters', {
      code: 'CATEGORY_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  return name;
}

function normalizeCategoryColor(colorInput: unknown): string | null {
  if (colorInput === null || colorInput === undefined) {
    return null;
  }

  const color = typeof colorInput === 'string' ? colorInput.trim() : '';
  if (!CATEGORY_COLOR_PATTERN.test(color)) {
    throw new AppError('Category color must be a hex color in the format #rrggbb', {
      code: 'CATEGORY_COLOR_INVALID',
      statusCode: 400,
    });
  }
  return color;
}

function assertCategoryNameAvailable(name: string, excludeCategoryId: string | null = null): void {
  const existingCategory = categoriesDb.getCategoryByName(name);
  if (existingCategory && existingCategory.category_id !== excludeCategoryId) {
    throw new AppError('A category with this name already exists', {
      code: 'CATEGORY_NAME_TAKEN',
      statusCode: 409,
    });
  }
}

function getCategoryOrThrow(categoryId: string): CategoryRepositoryRow {
  const category = categoriesDb.getCategoryById(categoryId);
  if (!category) {
    throw new AppError('Category not found', {
      code: 'CATEGORY_NOT_FOUND',
      statusCode: 404,
    });
  }
  return category;
}

export function listCategories(): CategoryApiView[] {
  return categoriesDb.getCategories().map(mapCategoryRow);
}

export function createCategory(nameInput: unknown, colorInput: unknown): CategoryApiView {
  const name = normalizeCategoryName(nameInput);
  assertCategoryNameAvailable(name);
  const color = normalizeCategoryColor(colorInput);

  const createdCategory = categoriesDb.createCategory(name, color);
  return mapCategoryRow(createdCategory);
}

export function updateCategory(
  categoryId: string,
  updates: { name?: unknown; color?: unknown },
): CategoryApiView {
  getCategoryOrThrow(categoryId);

  const fields: { name?: string; color?: string | null } = {};
  if (updates.name !== undefined) {
    const name = normalizeCategoryName(updates.name);
    assertCategoryNameAvailable(name, categoryId);
    fields.name = name;
  }
  if (updates.color !== undefined) {
    fields.color = normalizeCategoryColor(updates.color);
  }

  categoriesDb.updateCategory(categoryId, fields);
  return mapCategoryRow(getCategoryOrThrow(categoryId));
}

export function deleteCategory(categoryId: string): void {
  getCategoryOrThrow(categoryId);
  projectsDb.clearCategoryFromProjects(categoryId);
  categoriesDb.deleteCategory(categoryId);
}

export function reorderCategories(categoryIds: unknown): CategoryApiView[] {
  if (!Array.isArray(categoryIds) || categoryIds.some((id) => typeof id !== 'string')) {
    throw new AppError('categoryIds must be an array of strings', {
      code: 'CATEGORY_IDS_INVALID',
      statusCode: 400,
    });
  }

  const existingCategoryIds = new Set(
    categoriesDb.getCategories().map((category) => category.category_id),
  );
  const seenCategoryIds = new Set<string>();
  const orderedIds: string[] = [];
  for (const categoryId of categoryIds as string[]) {
    if (!existingCategoryIds.has(categoryId) || seenCategoryIds.has(categoryId)) {
      continue;
    }
    seenCategoryIds.add(categoryId);
    orderedIds.push(categoryId);
  }

  categoriesDb.reorderCategories(orderedIds);
  return listCategories();
}

/**
 * Assigns a project to a category, or clears the assignment when `categoryId` is null.
 */
export function setProjectCategory(
  projectId: string,
  categoryId: string | null,
): SetProjectCategoryResult {
  const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  if (!normalizedProjectId) {
    throw new AppError('projectId is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const project = projectsDb.getProjectById(normalizedProjectId);
  if (!project) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  let resolvedCategoryId: string | null = null;
  if (categoryId !== null && categoryId !== undefined) {
    resolvedCategoryId = typeof categoryId === 'string' ? categoryId.trim() : '';
    if (!resolvedCategoryId || !categoriesDb.getCategoryById(resolvedCategoryId)) {
      throw new AppError('Category not found', {
        code: 'CATEGORY_NOT_FOUND',
        statusCode: 404,
      });
    }
  }

  projectsDb.updateProjectCategoryById(normalizedProjectId, resolvedCategoryId);
  return { categoryId: resolvedCategoryId };
}
