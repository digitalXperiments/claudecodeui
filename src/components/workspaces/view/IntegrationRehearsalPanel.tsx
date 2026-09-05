import { FlaskConical, Loader2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import type { AgentWorkspace, IntegrationRehearsalResult } from '../types';

type IntegrationRehearsalPanelProps = {
  workspaces: AgentWorkspace[];
  selectedIds: string[];
  baseSha: string;
  result: IntegrationRehearsalResult | null;
  isRehearsing: boolean;
  onToggle: (workspaceId: string) => void;
  onBaseShaChange: (value: string) => void;
  onRun: () => void;
};

function outcomeClass(outcome: string): string {
  if (outcome === 'success') return 'text-emerald-400';
  if (outcome === 'merge_conflict') return 'text-amber-400';
  return 'text-red-400';
}

export default function IntegrationRehearsalPanel({
  workspaces,
  selectedIds,
  baseSha,
  result,
  isRehearsing,
  onToggle,
  onBaseShaChange,
  onRun,
}: IntegrationRehearsalPanelProps) {
  const eligible = workspaces.filter(
    (workspace) =>
      workspace.mode === 'git_worktree' &&
      Boolean(workspace.feature_branch) &&
      (workspace.status === 'active' || workspace.status === 'merged'),
  );

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Integration rehearsal</h4>
          <p className="text-[11px] text-muted-foreground">
            Combine committed tips from at least two workspaces in a disposable worktree. Primary checkout is never merged.
          </p>
        </div>
        {isRehearsing && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
      </div>

      {eligible.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Need two completed git workspaces in this project.</p>
      ) : (
        <div className="space-y-2">
          {eligible.map((workspace) => (
            <label key={workspace.workspace_id} className="flex items-start gap-2 text-[11px] text-foreground">
              <input
                type="checkbox"
                checked={selectedIds.includes(workspace.workspace_id)}
                onChange={() => onToggle(workspace.workspace_id)}
              />
              <span>
                <span className="font-medium">{workspace.feature_branch}</span>
                <span className="ml-2 text-muted-foreground">{workspace.head_sha?.slice(0, 8) ?? 'no sha'}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <label className="block text-[11px] text-muted-foreground">
        Explicit common base SHA
        <input
          value={baseSha}
          onChange={(event) => onBaseShaChange(event.target.value)}
          placeholder={eligible[0]?.base_sha ?? '40-character SHA'}
          className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>

      <Button
        size="sm"
        variant="outline"
        onClick={onRun}
        disabled={isRehearsing || selectedIds.length < 2 || !baseSha.trim()}
      >
        <FlaskConical />
        Rehearse integration
      </Button>

      {result && (
        <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3 text-[11px]">
          <div className={`font-semibold ${outcomeClass(result.outcome)}`}>
            {result.outcome.replace('_', ' ')} · {result.message}
          </div>
          <div className="text-muted-foreground">Base {result.base_sha}</div>
          <ul className="space-y-1">
            {result.inputs.map((entry) => (
              <li key={entry.workspace_id}>
                {entry.feature_branch} @ {entry.head_sha}
              </li>
            ))}
          </ul>
          {result.merge_conflicts.length > 0 && (
            <div>
              <div className="font-medium text-amber-400">Merge conflicts (tests not run)</div>
              {result.merge_conflicts.map((file) => (
                <div key={file}>{file}</div>
              ))}
            </div>
          )}
          {result.test && (
            <div>
              <div className={result.test.passed ? 'text-emerald-400' : 'text-red-400'}>
                Test {result.test.passed ? 'passed' : 'failed'} · {result.test.command} · exit {result.test.exit_code ?? 'n/a'} · {result.test.duration_ms}ms
              </div>
              {(result.test.stdout || result.test.stderr) && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
                  {result.test.stderr || result.test.stdout}
                </pre>
              )}
            </div>
          )}
          {result.warnings.map((warning) => (
            <div key={warning} className="text-amber-400">
              {warning}
            </div>
          ))}
          <div className="text-muted-foreground">Cleanup {result.cleaned_up ? 'complete' : 'incomplete'}</div>
        </div>
      )}
    </div>
  );
}
