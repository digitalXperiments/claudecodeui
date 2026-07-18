import assert from 'node:assert/strict';
import test from 'node:test';

import { categoriesDb, projectsDb } from '@/modules/database/index.js';
import {
  createCategory,
  deleteCategory,
  reorderCategories,
  setProjectCategory,
  updateCategory,
} from '@/modules/projects/services/project-categories.service.js';
import { AppError } from '@/shared/utils.js';

type CategoryRow = {
  category_id: string;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
};

type ProjectRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
  category_id: string | null;
};

function buildCategoryRow(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    category_id: 'category-1',
    name: 'Work',
    color: null,
    sort_order: 0,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function buildProjectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    project_id: 'project-1',
    project_path: '/workspace/project-1',
    custom_project_name: 'project-1',
    isStarred: 0,
    isArchived: 0,
    category_id: null,
    ...overrides,
  };
}

test('createCategory throws when name is blank', () => {
  assert.throws(
    () => createCategory('   ', null),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'CATEGORY_NAME_REQUIRED'
      && error.statusCode === 400,
  );
});

test('createCategory throws when name is already taken', () => {
  const originalGetCategoryByName = categoriesDb.getCategoryByName;
  try {
    categoriesDb.getCategoryByName = () => buildCategoryRow({ name: 'work' });
    assert.throws(
      () => createCategory('Work', null),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'CATEGORY_NAME_TAKEN'
        && error.statusCode === 409,
    );
  } finally {
    categoriesDb.getCategoryByName = originalGetCategoryByName;
  }
});

test('createCategory throws when color is not a hex color', () => {
  const originalGetCategoryByName = categoriesDb.getCategoryByName;
  try {
    categoriesDb.getCategoryByName = () => null;
    assert.throws(
      () => createCategory('Work', 'blue'),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'CATEGORY_COLOR_INVALID'
        && error.statusCode === 400,
    );
  } finally {
    categoriesDb.getCategoryByName = originalGetCategoryByName;
  }
});

test('createCategory trims input and returns the mapped category', () => {
  const originalGetCategoryByName = categoriesDb.getCategoryByName;
  const originalCreateCategory = categoriesDb.createCategory;

  let capturedName = '';
  let capturedColor: string | null = null;

  try {
    categoriesDb.getCategoryByName = () => null;
    categoriesDb.createCategory = (name: string, color: string | null) => {
      capturedName = name;
      capturedColor = color;
      return buildCategoryRow({
        category_id: 'category-9',
        name,
        color,
        sort_order: 3,
      });
    };

    const result = createCategory('  Work  ', '#A1b2C3');

    assert.equal(capturedName, 'Work');
    assert.equal(capturedColor, '#A1b2C3');
    assert.deepEqual(result, {
      categoryId: 'category-9',
      name: 'Work',
      color: '#A1b2C3',
      sortOrder: 3,
    });
  } finally {
    categoriesDb.getCategoryByName = originalGetCategoryByName;
    categoriesDb.createCategory = originalCreateCategory;
  }
});

test('updateCategory throws when category does not exist', () => {
  const originalGetCategoryById = categoriesDb.getCategoryById;
  try {
    categoriesDb.getCategoryById = () => null;
    assert.throws(
      () => updateCategory('missing-category', { name: 'Renamed' }),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'CATEGORY_NOT_FOUND'
        && error.statusCode === 404,
    );
  } finally {
    categoriesDb.getCategoryById = originalGetCategoryById;
  }
});

test('updateCategory applies provided fields and returns the re-read category', () => {
  const originalGetCategoryById = categoriesDb.getCategoryById;
  const originalGetCategoryByName = categoriesDb.getCategoryByName;
  const originalUpdateCategory = categoriesDb.updateCategory;

  let capturedFields: { name?: string; color?: string | null } | null = null;

  try {
    categoriesDb.getCategoryById = () => buildCategoryRow({ name: 'Renamed', color: '#00ff00' });
    categoriesDb.getCategoryByName = () => null;
    categoriesDb.updateCategory = (_categoryId: string, fields: { name?: string; color?: string | null }) => {
      capturedFields = fields;
    };

    const result = updateCategory('category-1', { name: ' Renamed ', color: '#00ff00' });

    assert.deepEqual(capturedFields, { name: 'Renamed', color: '#00ff00' });
    assert.deepEqual(result, {
      categoryId: 'category-1',
      name: 'Renamed',
      color: '#00ff00',
      sortOrder: 0,
    });
  } finally {
    categoriesDb.getCategoryById = originalGetCategoryById;
    categoriesDb.getCategoryByName = originalGetCategoryByName;
    categoriesDb.updateCategory = originalUpdateCategory;
  }
});

test('deleteCategory clears projects before deleting the category', () => {
  const originalGetCategoryById = categoriesDb.getCategoryById;
  const originalClearCategoryFromProjects = projectsDb.clearCategoryFromProjects;
  const originalDeleteCategory = categoriesDb.deleteCategory;

  const calls: string[] = [];

  try {
    categoriesDb.getCategoryById = () => buildCategoryRow();
    projectsDb.clearCategoryFromProjects = (categoryId: string) => {
      calls.push(`clear:${categoryId}`);
    };
    categoriesDb.deleteCategory = (categoryId: string) => {
      calls.push(`delete:${categoryId}`);
    };

    deleteCategory('category-1');

    assert.deepEqual(calls, ['clear:category-1', 'delete:category-1']);
  } finally {
    categoriesDb.getCategoryById = originalGetCategoryById;
    projectsDb.clearCategoryFromProjects = originalClearCategoryFromProjects;
    categoriesDb.deleteCategory = originalDeleteCategory;
  }
});

test('reorderCategories rejects non-string-array input', () => {
  assert.throws(
    () => reorderCategories('category-1'),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'CATEGORY_IDS_INVALID'
      && error.statusCode === 400,
  );
  assert.throws(
    () => reorderCategories(['category-1', 42]),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'CATEGORY_IDS_INVALID'
      && error.statusCode === 400,
  );
});

test('reorderCategories filters unknown and duplicate ids, preserving given order', () => {
  const originalGetCategories = categoriesDb.getCategories;
  const originalReorderCategories = categoriesDb.reorderCategories;

  let capturedIds: string[] = [];

  try {
    categoriesDb.getCategories = () => [
      buildCategoryRow({ category_id: 'category-a', name: 'A', sort_order: 0 }),
      buildCategoryRow({ category_id: 'category-b', name: 'B', sort_order: 1 }),
    ];
    categoriesDb.reorderCategories = (orderedIds: string[]) => {
      capturedIds = orderedIds;
    };

    const result = reorderCategories(['category-b', 'missing-category', 'category-a', 'category-b']);

    assert.deepEqual(capturedIds, ['category-b', 'category-a']);
    assert.deepEqual(
      result.map((category) => category.categoryId),
      ['category-a', 'category-b'],
    );
  } finally {
    categoriesDb.getCategories = originalGetCategories;
    categoriesDb.reorderCategories = originalReorderCategories;
  }
});

test('setProjectCategory throws when projectId is missing', () => {
  assert.throws(
    () => setProjectCategory('   ', 'category-1'),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'PROJECT_ID_REQUIRED'
      && error.statusCode === 400,
  );
});

test('setProjectCategory throws when project does not exist', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  try {
    projectsDb.getProjectById = () => null;
    assert.throws(
      () => setProjectCategory('project-1', 'category-1'),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'PROJECT_NOT_FOUND'
        && error.statusCode === 404,
    );
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
  }
});

test('setProjectCategory throws when category does not exist', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalGetCategoryById = categoriesDb.getCategoryById;
  try {
    projectsDb.getProjectById = () => buildProjectRow();
    categoriesDb.getCategoryById = () => null;
    assert.throws(
      () => setProjectCategory('project-1', 'missing-category'),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'CATEGORY_NOT_FOUND'
        && error.statusCode === 404,
    );
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    categoriesDb.getCategoryById = originalGetCategoryById;
  }
});

test('setProjectCategory accepts null categoryId to clear the assignment', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalGetCategoryById = categoriesDb.getCategoryById;
  const originalUpdateProjectCategoryById = projectsDb.updateProjectCategoryById;

  let capturedProjectId = '';
  let capturedCategoryId: string | null = 'unset';
  let categoryLookupCount = 0;

  try {
    projectsDb.getProjectById = () => buildProjectRow();
    categoriesDb.getCategoryById = (categoryId: string) => {
      categoryLookupCount += 1;
      return buildCategoryRow({ category_id: categoryId });
    };
    projectsDb.updateProjectCategoryById = (projectId: string, categoryId: string | null) => {
      capturedProjectId = projectId;
      capturedCategoryId = categoryId;
    };

    const result = setProjectCategory('project-1', null);

    assert.equal(result.categoryId, null);
    assert.equal(capturedProjectId, 'project-1');
    assert.equal(capturedCategoryId, null);
    assert.equal(categoryLookupCount, 0);
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    categoriesDb.getCategoryById = originalGetCategoryById;
    projectsDb.updateProjectCategoryById = originalUpdateProjectCategoryById;
  }
});

test('setProjectCategory assigns an existing category', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalGetCategoryById = categoriesDb.getCategoryById;
  const originalUpdateProjectCategoryById = projectsDb.updateProjectCategoryById;

  let capturedCategoryId: string | null = null;

  try {
    projectsDb.getProjectById = () => buildProjectRow();
    categoriesDb.getCategoryById = () => buildCategoryRow();
    projectsDb.updateProjectCategoryById = (_projectId: string, categoryId: string | null) => {
      capturedCategoryId = categoryId;
    };

    const result = setProjectCategory('project-1', 'category-1');

    assert.equal(result.categoryId, 'category-1');
    assert.equal(capturedCategoryId, 'category-1');
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    categoriesDb.getCategoryById = originalGetCategoryById;
    projectsDb.updateProjectCategoryById = originalUpdateProjectCategoryById;
  }
});
