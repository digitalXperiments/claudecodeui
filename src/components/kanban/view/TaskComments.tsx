import { useCallback, useEffect, useState } from 'react';
import { Bot, Loader2, Send, Trash2, User } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { kanbanApi } from '../api/kanbanApi';
import type { KanbanTaskComment } from '../types';

type TaskCommentsProps = {
  taskId: string;
  /**
   * Changing value that triggers a refetch — pass something derived from the
   * task's lifecycle (e.g. `${status}:${updated_at}`) so agent comments posted
   * when a run completes show up without a manual reload.
   */
  refreshSignal?: string;
};

function formatWhen(iso: string): string {
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

/**
 * Activity trail for a task: human notes plus the high-level output each agent
 * run leaves behind. Read + append; deletion is available for tidying up.
 */
export default function TaskComments({ taskId, refreshSignal }: TaskCommentsProps) {
  const [comments, setComments] = useState<KanbanTaskComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await kanbanApi.listComments(taskId);
      setComments(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load comments');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const submit = async () => {
    const body = text.trim();
    if (!body) {
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const comment = await kanbanApi.addComment(taskId, body);
      setComments((prev) => [...prev, comment]);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (commentId: string) => {
    const prev = comments;
    setComments((current) => current.filter((c) => c.comment_id !== commentId));
    try {
      await kanbanApi.deleteComment(taskId, commentId);
    } catch (err) {
      setComments(prev);
      setError(err instanceof Error ? err.message : 'Failed to delete comment');
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <span className="text-xs font-medium text-muted-foreground">
        Activity {comments.length > 0 ? `(${comments.length})` : ''}
      </span>

      {loading && comments.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {comments.map((comment) => {
            const isAgent = comment.author_type === 'agent';
            return (
              <div
                key={comment.comment_id}
                className={cn(
                  'group rounded-md border p-2 text-sm',
                  isAgent ? 'border-primary/20 bg-primary/5' : 'border-border bg-background',
                )}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {isAgent ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                  <span className="font-medium">
                    {isAgent ? comment.author ?? 'Agent' : comment.author ?? 'You'}
                  </span>
                  <span>· {formatWhen(comment.created_at)}</span>
                  <button
                    type="button"
                    className="ml-auto opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    onClick={() => void remove(comment.comment_id)}
                    aria-label="Delete comment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                  {comment.body}
                </p>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
        />
        <Button size="sm" onClick={() => void submit()} disabled={posting || !text.trim()}>
          {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
