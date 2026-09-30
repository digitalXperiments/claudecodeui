import type { BotRunEvent } from '../../api/botStudioApi';

export type TimelineTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export type ExplainableRunStep = {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  tone: TimelineTone;
  payload: Record<string, unknown>;
  sequence: number;
};

function stringField(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function numberField(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function compactValue(value: unknown, limit = 180): string | null {
  if (value == null) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > limit ? normalized.slice(0, limit - 1) + '…' : normalized;
}

function humanize(value: string): string {
  const text = value.replace(/[._-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Run event';
}

function joined(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

function formatTokens(value: number | null): string | null {
  return value == null ? null : value.toLocaleString() + ' tokens';
}

function describeEvent(event: BotRunEvent): Omit<ExplainableRunStep, 'id' | 'timestamp' | 'payload' | 'sequence'> {
  const payload = event.payload ?? {};
  const tool = stringField(payload, 'tool', 'tool_name') ?? 'tool';
  const decision = stringField(payload, 'decision', 'reason');
  const summary = stringField(payload, 'summary', 'content', 'error_summary');
  const trigger = stringField(payload, 'trigger');
  const statusTo = stringField(payload, 'to', 'status');
  const isError = payload.is_error === true || event.severity === 'error';

  switch (event.type) {
    case 'run.queued':
      return { title: 'Queued', description: joined(trigger ? humanize(trigger) + ' trigger' : null, stringField(payload, 'title')) || 'The tick entered the run queue.', tone: 'neutral' };
    case 'run.started':
      return { title: 'Execution started', description: joined(stringField(payload, 'cwd'), stringField(payload, 'pid') ? 'Process ' + stringField(payload, 'pid') : null) || 'The provider process started.', tone: 'info' };
    case 'run.first_token':
      return { title: 'First response received', description: joined(stringField(payload, 'provider'), stringField(payload, 'model')) || 'The model began responding.', tone: 'info' };
    case 'run.status':
      if (isError) return { title: 'Provider reported an error', description: compactValue(summary) || 'The provider emitted an error status.', tone: 'error' };
      return { title: statusTo ? 'Status changed to ' + humanize(statusTo).toLowerCase() : 'Status updated', description: summary || joined(stringField(payload, 'from'), statusTo) || 'The execution state changed.', tone: statusTo?.startsWith('waiting') ? 'warning' : 'info' };
    case 'model.selected':
      return { title: 'Model selected', description: joined(stringField(payload, 'provider'), stringField(payload, 'model'), stringField(payload, 'effort')), tone: 'neutral' };
    case 'workspace.bound':
      return { title: 'Workspace attached', description: joined(stringField(payload, 'root_path', 'workspace_id'), stringField(payload, 'feature_branch')) || 'The run was bound to a workspace.', tone: 'neutral' };
    case 'tool.call':
      return { title: 'Called ' + tool, description: compactValue(payload.args_summary ?? payload.input) || 'The bot invoked this tool.', tone: 'info' };
    case 'tool.result':
      return { title: tool + (isError ? ' failed' : ' completed'), description: compactValue(payload.summary ?? payload.content) || (isError ? 'The tool returned an error.' : 'The tool returned successfully.'), tone: isError ? 'error' : 'success' };
    case 'permission.requested':
      return { title: 'Permission requested', description: joined(tool !== 'tool' ? tool : null, stringField(payload, 'reason')) || 'The run paused for permission.', tone: 'warning' };
    case 'permission.resolved':
      return { title: 'Permission resolved', description: decision ? humanize(decision) : payload.resolved === false ? 'Cancelled or denied' : 'The permission request was resolved.', tone: payload.resolved === false || decision === 'deny' || decision === 'denied' ? 'error' : 'success' };
    case 'approval.requested':
      return { title: 'Approval requested', description: stringField(payload, 'item_id') ? 'Inbox item ' + stringField(payload, 'item_id') : 'The run paused for human review.', tone: 'warning' };
    case 'approval.resolved':
      return { title: 'Approval resolved', description: decision ? humanize(decision) : 'The approval request was resolved.', tone: decision === 'deny' || decision === 'denied' || decision === 'rejected' ? 'error' : 'success' };
    case 'token.usage': {
      const total = numberField(payload, 'total');
      const cost = numberField(payload, 'cost_usd_estimate');
      return { title: 'Usage recorded', description: joined(formatTokens(total), cost == null ? null : '$' + cost.toFixed(4)) || 'Token usage was updated.', tone: 'neutral' };
    }
    case 'git.commit':
      return { title: 'Commit created', description: joined(stringField(payload, 'sha'), stringField(payload, 'message')) || 'The run created a commit.', tone: 'success' };
    case 'git.diff_summary': {
      const files = numberField(payload, 'files');
      const additions = numberField(payload, 'additions');
      const deletions = numberField(payload, 'deletions');
      return { title: 'Changes captured', description: joined(files == null ? null : String(files) + ' files', additions == null ? null : '+' + String(additions), deletions == null ? null : '-' + String(deletions)) || 'A diff summary was recorded.', tone: 'neutral' };
    }
    case 'test.started':
      return { title: 'Tests started', description: stringField(payload, 'command') || 'The validation command started.', tone: 'info' };
    case 'test.finished': {
      const exitCode = numberField(payload, 'exit_code');
      return { title: exitCode === 0 ? 'Tests passed' : 'Tests failed', description: exitCode == null ? 'The validation command finished.' : 'Exit code ' + String(exitCode), tone: exitCode === 0 ? 'success' : 'error' };
    }
    case 'run.completed':
      return { title: 'Run completed', description: summary || 'The tick finished successfully.', tone: 'success' };
    case 'run.failed':
      return { title: 'Run failed', description: summary || 'The tick ended with an error.', tone: 'error' };
    case 'run.aborted':
      return { title: 'Run cancelled', description: decision || 'The tick was stopped before completion.', tone: 'warning' };
    case 'failover.triggered':
      return { title: 'Failover triggered', description: joined(stringField(payload, 'from_provider'), stringField(payload, 'to_provider')) || 'The run switched providers.', tone: 'warning' };
    case 'pack.attached':
      return { title: 'Context attached', description: joined(stringField(payload, 'pack_id'), formatTokens(numberField(payload, 'estimated_tokens'))) || 'A context pack was attached.', tone: 'neutral' };
    default:
      return { title: humanize(event.type), description: compactValue(summary) || humanize(event.source) + ' recorded this event.', tone: isError ? 'error' : event.severity === 'warn' ? 'warning' : 'neutral' };
  }
}

export function selectExplainableRunSteps(events: BotRunEvent[]): ExplainableRunStep[] {
  return [...events]
    .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) || a.ts.localeCompare(b.ts))
    .map((event, index) => ({
      id: event.event_id || event.run_id + '-' + String(event.seq ?? index),
      timestamp: event.ts,
      payload: event.payload ?? {},
      sequence: event.seq ?? index + 1,
      ...describeEvent(event),
    }));
}
