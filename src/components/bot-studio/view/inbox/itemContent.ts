import type { McItem } from '../../../mission-control/api/missionControlApi';

export type ItemContentPreview = {
  label: string;
  text?: string;
  actionItems?: string[];
};

const CONTENT_FIELDS: Array<[key: string, label: string]> = [
  ['whatNeedsToBeDone', 'What needs to be done'],
  ['problemStatement', 'Problem'],
  ['description', 'Description'],
  ['prompt', 'Brief'],
  ['background', 'Context'],
  ['resolution', 'Resolution'],
  ['markdown', 'Content'],
];

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pull the useful, human-readable part of an agent-produced item out of its
 * structured body. The body is intentionally not rendered as raw JSON in the
 * inbox: most integrations put their actual brief here rather than in source.
 */
export function getItemContentPreview(item: Pick<McItem, 'body'>): ItemContentPreview | null {
  const body = item.body ?? {};
  for (const [key, label] of CONTENT_FIELDS) {
    const text = nonEmptyString(body[key]);
    if (text) {
      const actionItems = Array.isArray(body.actionItems)
        ? body.actionItems.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())
        : undefined;
      return { label, text, actionItems: actionItems?.length ? actionItems : undefined };
    }
  }

  const actionItems = Array.isArray(body.actionItems)
    ? body.actionItems.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())
    : [];
  return actionItems.length ? { label: 'Action items', actionItems } : null;
}
