import { AlertTriangle, FileDiff, GitBranch, GitMerge, Loader2, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';

import { useWorkspaces } from '../hooks/useWorkspaces';
import ShipStepper from './ShipStepper';

type WorkspacesViewProps = { selectedProject: Project | null };

function statusClass(status: string): string {
  if (status === 'active') return 'text-emerald-400';
  if (status === 'error' || status === 'orphan') return 'text-red-400';
  return 'text-amber-400';
}

export default function WorkspacesView({ selectedProject }: WorkspacesViewProps) {
  const state = useWorkspaces(selectedProject?.projectId ?? null);

  if (!selectedProject) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a project to view workspaces</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Agent workspaces</h2>
          <p className="text-xs text-muted-foreground">Isolated branches for autonomous runs</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void state.refresh()} disabled={state.isLoading} aria-label="Refresh workspaces">
          {state.isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {state.error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(220px,0.35fr)_minmax(0,0.65fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-border/60 p-3 lg:border-b-0 lg:border-r">
          {state.workspaces.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
              No workspaces yet. Starting an autonomous Kanban run will create one here.
            </div>
          ) : (
            <div className="space-y-2">
              {state.workspaces.map((workspace) => (
                <button
                  key={workspace.workspace_id}
                  type="button"
                  onClick={() => state.select(workspace.workspace_id)}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${
                    state.selectedId === workspace.workspace_id
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border/60 hover:bg-accent/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {workspace.task_id ? `Task ${workspace.task_id.slice(0, 8)}` : workspace.workspace_id.slice(0, 15)}
                    </span>
                    <span className={`text-[11px] font-medium ${statusClass(workspace.status)}`}>{workspace.status}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    {workspace.feature_branch || workspace.mode}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          {!state.selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Choose a workspace</div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">{state.selected.feature_branch || state.selected.mode}</h3>
                  </div>
                  <p className="mt-1 max-w-xl break-all text-xs text-muted-foreground">{state.selected.root_path}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {state.selected.status === 'active' && (
                    <>
                      <Button size="sm" variant="default" onClick={() => void state.merge()} disabled={state.isLoading}>
                        <GitMerge /> Merge
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => { if (window.confirm('Discard this workspace and its branch?')) void state.discard(); }} disabled={state.isLoading}>
                        <Trash2 /> Discard
                      </Button>
                    </>
                  )}
                  {state.selected.status === 'merged' && (
                    <Button size="sm" variant="outline" onClick={() => void state.cleanup()} disabled={state.isLoading}>
                      <Trash2 /> Cleanup
                    </Button>
                  )}
                </div>
              </div>

              {state.status && (
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded-md border border-border/60 p-2"><span className="text-muted-foreground">State</span><div className={statusClass(state.status.status)}>{state.status.status}</div></div>
                  <div className="rounded-md border border-border/60 p-2"><span className="text-muted-foreground">Ahead</span><div className="text-foreground">{state.status.ahead}</div></div>
                  <div className="rounded-md border border-border/60 p-2"><span className="text-muted-foreground">Behind</span><div className="text-foreground">{state.status.behind}</div></div>
                  <div className="rounded-md border border-border/60 p-2"><span className="text-muted-foreground">Dirty files</span><div className="text-foreground">{state.status.dirty_files.length}</div></div>
                </div>
              )}

              {state.diff && (
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
                    <FileDiff className="h-4 w-4" /> Diff ({state.diff.summary.additions} additions, {state.diff.summary.deletions} deletions)
                  </div>
                  {state.diff.files.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No committed diff from the base branch.</p>
                  ) : (
                    <div className="space-y-2">
                      {state.diff.files.map((file) => (
                        <details key={file.path} className="overflow-hidden rounded-md border border-border/60">
                          <summary className="cursor-pointer px-3 py-2 text-xs text-foreground">{file.status} · {file.path}</summary>
                          {file.patch && <pre className="max-h-72 overflow-auto border-t border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">{file.patch}</pre>}
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <ShipStepper
                workspace={state.selected}
                testReport={state.testReport}
                pullRequest={state.pullRequest}
                ciStatus={state.ciStatus}
                isShipping={state.isShipping}
                onTest={() => void state.runShipTest()}
                onCreatePr={() => void state.createShipPr()}
                onRefreshCi={() => void state.refreshShipCi()}
                onFixCi={(summary) => void state.openShipFix(summary)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
