import type { ChatMessage } from '../types/types';

import { groupMemberHeightKey } from './rowHeightCache';
import { isToolGroupItem, type MessageListItem } from './toolGrouping';

/** Tail rows that mount their content on the first commit of a transcript. */
export const INITIAL_MOUNTED_TAIL_ROWS = 30;
/**
 * Newly prepended rows nearest the reading position that mount on their first
 * commit, so the pre-paint correction uses real heights. Bounded so "Load all"
 * cannot mount thousands of subtrees at once.
 */
export const PREPEND_MOUNTED_ROWS = 40;

export type TranscriptRowDescriptor = {
  key: string;
  memberKeys: string[];
  heightKeys: string[];
  mountInitially: boolean;
};

export type TranscriptRowModel = {
  rows: TranscriptRowDescriptor[];
  /** member message key → group row key, to carry into the next render. */
  groupKeyByMember: Map<string, string>;
};

/**
 * Derives stable React keys and first-commit mount hints for grouped rows.
 *
 * Tool groups used to be keyed by their first member, so prepending an older
 * page ending in the same tool re-keyed (remounted) the group at the reading
 * position. A group now keeps the key it was first rendered with, found via
 * any member it had before; new groups fall back to the first-member key.
 */
export function buildTranscriptRowModel(
  items: MessageListItem[],
  getMessageKey: (message: ChatMessage) => string,
  previousGroupKeyByMember: ReadonlyMap<string, string>,
  previousRowKeys: ReadonlySet<string>,
): TranscriptRowModel {
  const groupKeyByMember = new Map<string, string>();
  const usedKeys = new Set<string>();
  const rows: TranscriptRowDescriptor[] = items.map((item) => {
    if (!isToolGroupItem(item)) {
      const key = getMessageKey(item);
      usedKeys.add(key);
      return { key, memberKeys: [], heightKeys: [key], mountInitially: false };
    }
    const memberKeys = item.messages.map(getMessageKey);
    let key: string | undefined;
    for (const memberKey of memberKeys) {
      const remembered = previousGroupKeyByMember.get(memberKey);
      if (remembered && !usedKeys.has(remembered)) {
        key = remembered;
        break;
      }
    }
    if (!key || usedKeys.has(key)) key = `tool-group-${memberKeys[0]}`;
    let suffix = 1;
    while (usedKeys.has(key)) key = `tool-group-${memberKeys[0]}__${suffix++}`;
    usedKeys.add(key);
    for (const memberKey of memberKeys) groupKeyByMember.set(memberKey, key);
    return {
      key,
      memberKeys,
      heightKeys: [key, ...memberKeys.map(groupMemberHeightKey)],
      mountInitially: false,
    };
  });

  const rowCount = rows.length;
  const firstKnown = previousRowKeys.size === 0 ? -1 : rows.findIndex((row) => previousRowKeys.has(row.key));

  if (firstKnown < 0) {
    // First render of this transcript: mount the tail only.
    for (let index = Math.max(0, rowCount - INITIAL_MOUNTED_TAIL_ROWS); index < rowCount; index++) {
      rows[index].mountInitially = true;
    }
    return { rows, groupKeyByMember };
  }

  // Prepended block [0, firstKnown): the rows closest to existing content are
  // where the reader is when an older page lands.
  for (let index = Math.max(0, firstKnown - PREPEND_MOUNTED_ROWS); index < firstKnown; index++) {
    rows[index].mountInitially = true;
  }
  // Rows that are new mid-list (re-keyed) or appended at the tail.
  let budget = PREPEND_MOUNTED_ROWS;
  for (let index = firstKnown; index < rowCount && budget > 0; index++) {
    if (!previousRowKeys.has(rows[index].key)) {
      rows[index].mountInitially = true;
      budget--;
    }
  }
  for (let index = Math.max(firstKnown, rowCount - INITIAL_MOUNTED_TAIL_ROWS); index < rowCount; index++) {
    if (!previousRowKeys.has(rows[index].key)) rows[index].mountInitially = true;
  }
  return { rows, groupKeyByMember };
}
