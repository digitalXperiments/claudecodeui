import { AlertTriangle, CheckCircle2, ExternalLink, GitPullRequest, Loader2, Play, RefreshCw, TestTube2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import type { AgentWorkspace, WorkspaceCiStatus, WorkspacePullRequest, WorkspaceTestReport } from '../types';

type ShipStepperProps = {
  workspace: AgentWorkspace;
  testReport: WorkspaceTestReport | null;
  pullRequest: WorkspacePullRequest | null;
  ciStatus: WorkspaceCiStatus | null;
  isShipping: boolean;
  onTest: () => void;
  onCreatePr: () => void;
  onRefreshCi: () => void;
  onFixCi: (summary: string) => void;
};

function Step({ number, title, done, active, children }: { number: number; title: string; done?: boolean; active?: boolean; children: React.ReactNode }) {
  return <div className={`rounded-md border p-3 ${active ? 'border-primary/50 bg-primary/5' : 'border-border/60'}`}><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground"><span className={`flex h-5 w-5 items-center justify-center rounded-full ${done ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'}`}>{done ? <CheckCircle2 className="h-3.5 w-3.5" /> : number}</span>{title}</div>{children}</div>;
}

export default function ShipStepper({ workspace, testReport, pullRequest, ciStatus, isShipping, onTest, onCreatePr, onRefreshCi, onFixCi }: ShipStepperProps) {
  const ciFailure = ciStatus?.state === 'failure';
  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="mb-2 flex items-center justify-between"><div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ship</h4><p className="text-[11px] text-muted-foreground">Diff → Test → PR → CI</p></div>{isShipping && <Loader2 className="h-4 w-4 animate-spin text-primary" />}</div>
      <div className="grid gap-2 md:grid-cols-4">
        <Step number={1} title="Diff" done={Boolean(workspace.feature_branch)}><p className="text-[11px] text-muted-foreground">{workspace.feature_branch ? `Branch ${workspace.feature_branch}` : 'No branch available'}</p></Step>
        <Step number={2} title="Test" done={Boolean(testReport?.passed)} active={!testReport}><div className="space-y-2"><p className={`text-[11px] ${testReport?.passed ? 'text-emerald-600' : 'text-muted-foreground'}`}>{testReport ? `${testReport.passed ? 'Passed' : 'Failed'} · ${testReport.command}` : 'Run the configured test command'}</p><Button size="sm" variant="outline" onClick={onTest} disabled={isShipping}><TestTube2 />{testReport ? 'Run again' : 'Run tests'}</Button></div></Step>
        <Step number={3} title="PR" done={Boolean(pullRequest)} active={Boolean(testReport) && !pullRequest}><div className="space-y-2"><p className="text-[11px] text-muted-foreground">{pullRequest ? pullRequest.title : 'Create a draft pull request'}</p>{pullRequest ? <a href={pullRequest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary underline"><ExternalLink className="h-3 w-3" />Open PR</a> : <Button size="sm" variant="outline" onClick={onCreatePr} disabled={isShipping || !testReport}><GitPullRequest />Create PR</Button>}</div></Step>
        <Step number={4} title="CI" done={ciStatus?.state === 'success'} active={Boolean(pullRequest)}><div className="space-y-2"><p className={`text-[11px] ${ciStatus?.state === 'failure' ? 'text-red-600' : ciStatus?.state === 'success' ? 'text-emerald-600' : 'text-muted-foreground'}`}>{ciStatus ? `${ciStatus.state}${ciStatus.checks.length ? ` · ${ciStatus.checks.length} checks` : ''}` : 'Refresh checks after PR creation'}</p><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={onRefreshCi} disabled={isShipping || !pullRequest}><RefreshCw />Check CI</Button>{ciFailure && workspace.run_id && <Button size="sm" variant="destructive" onClick={() => onFixCi(ciStatus.checks.filter((check) => /fail|error|cancel|timed/i.test(`${check.state} ${check.conclusion ?? ''}`)).map((check) => check.name).join(', ') || 'CI checks failed')} disabled={isShipping}><Play />Open fix run</Button>}</div></div></Step>
      </div>
      {ciFailure && <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />CI failure is recorded in the interrupt queue.</div>}
    </div>
  );
}
