/** First-party gateway tools the kernel contributes: commitments, goal progress, memory search. */

import { listBotMemories } from '@/modules/mission-control/index.js';

import { registerGatewayTool, textResult } from '../gateway/first-party-tools.js';

import { botEpisodesDb } from './bot-episodes.repository.js';
import { applyGoalProgress, createCommitmentChecked } from './kernel-actions.js';

const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 20;

/** Approved memories whose text contains at least one query term, best match first. */
function searchMemories(botId: string, query: string, limit: number): Array<{ memory_id: string; content: string }> {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  return listBotMemories(botId)
    .filter((memory) => memory.status === 'approved')
    .map((memory) => {
      const text = memory.content.toLowerCase();
      return { memory, hits: terms.filter((term) => text.includes(term)).length };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((entry) => ({ memory_id: entry.memory.memoryId, content: entry.memory.content }));
}

let registered = false;

/** Idempotent; called from `installKernel`. */
export function registerKernelGatewayTools(): void {
  if (registered) return;
  registered = true;

  registerGatewayTool('bot__commit', {
    description:
      'Record a follow-up you owe or are waiting on. You will be woken when it is due (at most 90 days out). Use it instead of trying to remember.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What must happen or be checked.' },
        due_at: { type: 'string', description: 'ISO 8601 timestamp for the follow-up.' },
        waiting_on: { type: 'string', description: 'Who or what you are waiting on.' },
        item_id: { type: 'string', description: 'Optional id or dedupeKey of one of your items.' },
        goal_id: { type: 'string', description: 'Optional goal this serves.' },
      },
      required: ['description', 'due_at'],
    },
    risk: 'draft',
    handler: (ctx, args) => {
      const result = createCommitmentChecked(ctx.botId, { ...args, item_ref: args.item_id });
      if (!result.ok) return textResult(result.error, true);
      const { commitment } = result;
      return textResult(JSON.stringify({ commitment_id: commitment.commitment_id, due_at: commitment.due_at, status: commitment.status }));
    },
  });

  registerGatewayTool('bot__goal_progress', {
    description: 'Record progress on one of your goals (note, optional percent 0-100, optional status change).',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string' },
        note: { type: 'string' },
        percent: { type: 'number' },
        status: { type: 'string', enum: ['active', 'paused', 'achieved', 'abandoned'] },
      },
      required: ['goal_id'],
    },
    risk: 'draft',
    handler: (ctx, args) => {
      const result = applyGoalProgress(ctx.botId, args, ctx.episodeId);
      if (!result.ok) return textResult(result.error, true);
      return textResult(JSON.stringify({ goal_id: result.goal.goal_id, status: result.goal.status, progress: result.goal.progress }));
    },
  });

  registerGatewayTool('bot__search_memory', {
    description: 'Search your past episode summaries and approved memories for a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: `Max results per source (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
      },
      required: ['query'],
    },
    risk: 'read',
    handler: (ctx, args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return textResult('query is required.', true);
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : SEARCH_DEFAULT_LIMIT;
      const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, requested));
      return textResult(
        JSON.stringify({
          episodes: botEpisodesDb.search(ctx.botId, query, limit),
          memories: searchMemories(ctx.botId, query, limit),
        }),
      );
    },
  });
}
