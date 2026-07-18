import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { CategoryRepositoryRow } from '@/shared/types.js';

export const categoriesDb = {
    getCategories(): CategoryRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT category_id, name, color, sort_order, created_at
            FROM categories
            ORDER BY sort_order ASC, name ASC
        `).all() as CategoryRepositoryRow[];
    },

    getCategoryById(categoryId: string): CategoryRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT category_id, name, color, sort_order, created_at
            FROM categories
            WHERE category_id = ?
        `).get(categoryId) as CategoryRepositoryRow | undefined;

        return row ?? null;
    },

    getCategoryByName(name: string): CategoryRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT category_id, name, color, sort_order, created_at
            FROM categories
            WHERE name = ? COLLATE NOCASE
        `).get(name) as CategoryRepositoryRow | undefined;

        return row ?? null;
    },

    createCategory(name: string, color: string | null): CategoryRepositoryRow {
        const db = getConnection();
        const categoryId = randomUUID();
        db.prepare(`
            INSERT INTO categories (category_id, name, color, sort_order)
            VALUES (?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM categories), 0))
        `).run(categoryId, name, color);

        return categoriesDb.getCategoryById(categoryId) as CategoryRepositoryRow;
    },

    updateCategory(categoryId: string, fields: { name?: string; color?: string | null }): void {
        const db = getConnection();
        if (fields.name !== undefined) {
            db.prepare(`
                UPDATE categories
                SET name = ?
                WHERE category_id = ?
            `).run(fields.name, categoryId);
        }

        if (fields.color !== undefined) {
            db.prepare(`
                UPDATE categories
                SET color = ?
                WHERE category_id = ?
            `).run(fields.color, categoryId);
        }
    },

    deleteCategory(categoryId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM categories
            WHERE category_id = ?
        `).run(categoryId);
    },

    reorderCategories(orderedIds: string[]): void {
        const db = getConnection();
        const updateSortOrder = db.prepare(`
            UPDATE categories
            SET sort_order = ?
            WHERE category_id = ?
        `);
        const applyOrder = db.transaction((categoryIds: string[]) => {
            categoryIds.forEach((categoryId, index) => {
                updateSortOrder.run(index, categoryId);
            });
        });

        applyOrder(orderedIds);
    },
};
