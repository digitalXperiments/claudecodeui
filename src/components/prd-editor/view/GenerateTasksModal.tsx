import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { authenticatedFetch } from '../../../utils/api';
import { PRD_DOCS_URL } from '../constants';
import type { DeliveryGraph } from '../../delivery-graph/types';

type GenerateTasksModalProps = {
  isOpen: boolean;
  fileName: string;
  projectId?: string;
  onClose: () => void;
};

type Step = 'generate' | 'edit' | 'apply';

function errorMessage(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((payload: { error?: { message?: string }; message?: string }) => payload.error?.message ?? payload.message ?? fallback)
    .catch(() => fallback);
}

export default function GenerateTasksModal({
  isOpen,
  fileName,
  projectId,
  onClose,
}: GenerateTasksModalProps) {
  const [step, setStep] = useState<Step>('generate');
  const [graph, setGraph] = useState<DeliveryGraph | null>(null);
  const [boardId, setBoardId] = useState<string>('');
  const [startReady, setStartReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ created: number; reused: number; queued: number } | null>(null);

  const prdPath = useMemo(() => {
    if (fileName.includes('/') || fileName.includes('\\')) return fileName;
    return `.taskmaster/docs/${fileName}`;
  }, [fileName]);

  if (!isOpen) return null;

  const resetAndClose = () => {
    setStep('generate');
    setGraph(null);
    setBoardId('');
    setError(null);
    setApplyResult(null);
    onClose();
  };

  const generate = async () => {
    if (!projectId) {
      setError('Select a project before generating tasks.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/delivery-graph/generate`, {
        method: 'POST',
        body: JSON.stringify({ prdPath }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, `Generation failed (${response.status})`));
      const payload = (await response.json()) as { graph?: DeliveryGraph };
      if (!payload.graph) throw new Error('The generator returned no delivery graph.');
      setGraph(payload.graph);
      setStep('edit');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to generate delivery graph.');
    } finally {
      setBusy(false);
    }
  };

  const updateTask = (tempId: string, patch: Partial<DeliveryGraph['tasks'][number]>) => {
    setGraph((current) => current
      ? { ...current, tasks: current.tasks.map((task) => task.tempId === tempId ? { ...task, ...patch } : task) }
      : current);
  };

  const apply = async () => {
    if (!projectId || !graph) return;
    setBusy(true);
    setError(null);
    try {
      let resolvedBoardId = boardId;
      if (!resolvedBoardId) {
        const boardResponse = await authenticatedFetch('/api/kanban/global');
        if (!boardResponse.ok) throw new Error(await errorMessage(boardResponse, 'Could not load the Kanban board.'));
        const boardPayload = (await boardResponse.json()) as { board?: { board_id?: string } };
        resolvedBoardId = boardPayload.board?.board_id ?? '';
      }
      if (!resolvedBoardId) throw new Error('No Kanban board is available.');
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/delivery-graph/apply`, {
        method: 'POST',
        body: JSON.stringify({ graph, boardId: resolvedBoardId, startReady }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, `Apply failed (${response.status})`));
      const payload = (await response.json()) as { created?: unknown[]; reused?: unknown[]; queued?: unknown[] };
      setBoardId(resolvedBoardId);
      setApplyResult({
        created: payload.created?.length ?? 0,
        reused: payload.reused?.length ?? 0,
        queued: payload.queued?.length ?? 0,
      });
      setStep('apply');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to apply delivery graph.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-5 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/50">
              <Sparkles className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Delivery graph</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">Generate → edit → apply to Kanban</p>
            </div>
          </div>
          <button onClick={resetAndClose} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-3 text-xs dark:border-gray-700">
          {(['generate', 'edit', 'apply'] as Step[]).map((name, index) => (
            <div key={name} className={`flex items-center gap-2 ${step === name ? 'font-semibold text-purple-600 dark:text-purple-300' : 'text-gray-400'}`}>
              <span className="flex h-5 w-5 items-center justify-center rounded-full border">{index + 1}</span>
              <span className="capitalize">{name}</span>
              {index < 2 && <ChevronRight className="h-3 w-3" />}
            </div>
          ))}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">{error}</div>}

          {step === 'generate' && (
            <div className="space-y-4">
              <div className="rounded-lg border border-purple-200 bg-purple-50 p-4 dark:border-purple-800 dark:bg-purple-900/20">
                <h4 className="font-semibold text-purple-900 dark:text-purple-100">Create an editable task graph</h4>
                <p className="mt-1 text-sm text-purple-800 dark:text-purple-200">CloudCLI will read the saved PRD and extract requirements, acceptance criteria, and implementation tasks.</p>
                <p className="mt-3 rounded border border-purple-200 bg-white p-2 font-mono text-xs text-gray-700 dark:border-purple-700 dark:bg-gray-800 dark:text-gray-300">{prdPath}</p>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Save the PRD before generating so the file on disk matches this editor.</p>
            </div>
          )}

          {step === 'edit' && graph && (
            <div className="space-y-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                Graph title
                <input value={graph.title} onChange={(event) => setGraph({ ...graph, title: event.target.value })} className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
              </label>
              {/* Simple dependency edge list (PRD §9.6). */}
              <div className="rounded-lg border border-dashed border-purple-200 bg-purple-50/50 p-3 dark:border-purple-800 dark:bg-purple-950/20">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-purple-800 dark:text-purple-200">Dependency graph</h4>
                <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto font-mono text-[11px] text-purple-900 dark:text-purple-100">
                  {graph.tasks.flatMap((task) =>
                    task.dependsOn.length === 0
                      ? [
                          <li key={`${task.tempId}-root`} className="opacity-70">
                            {task.tempId} <span className="opacity-50">({task.title || 'untitled'})</span> — ready (no deps)
                          </li>,
                        ]
                      : task.dependsOn.map((dep) => (
                          <li key={`${task.tempId}-${dep}`}>
                            {dep} → {task.tempId}{' '}
                            <span className="opacity-60">
                              ({task.title || 'untitled'})
                            </span>
                          </li>
                        )),
                  )}
                </ul>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Tasks ({graph.tasks.length})</h4>
                  <p className="text-xs text-gray-500">Edit titles and descriptions before creating Kanban cards.</p>
                </div>
                <button onClick={() => setGraph({ ...graph, tasks: [...graph.tasks, { tempId: `task-${Date.now()}`, title: 'New task', description: '', prompt: 'Implement this task and verify it.', reqIds: [], acceptanceIds: [], dependsOn: [] }] })} className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"><Plus className="h-3 w-3" />Add</button>
              </div>
              {graph.tasks.map((task) => (
                <div key={task.tempId} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <div className="flex gap-2">
                    <input value={task.title} onChange={(event) => updateTask(task.tempId, { title: event.target.value })} className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
                    <span className="rounded bg-gray-100 px-2 py-1.5 font-mono text-[10px] text-gray-500 dark:bg-gray-700">{task.tempId}</span>
                  </div>
                  <textarea value={task.description} onChange={(event) => updateTask(task.tempId, { description: event.target.value })} rows={3} className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200" />
                  <label className="block text-[10px] text-gray-500">
                    Depends on (comma-separated tempIds)
                    <input
                      value={task.dependsOn.join(', ')}
                      onChange={(event) =>
                        updateTask(task.tempId, {
                          dependsOn: event.target.value
                            .split(',')
                            .map((part) => part.trim())
                            .filter(Boolean),
                        })
                      }
                      className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 font-mono text-[11px] dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                      placeholder="task-1, task-2"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          {step === 'apply' && applyResult && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-5 dark:border-green-800 dark:bg-green-900/20">
              <div className="flex items-center gap-2 font-semibold text-green-800 dark:text-green-200"><Check className="h-5 w-5" />Delivery graph applied</div>
              <p className="mt-2 text-sm text-green-700 dark:text-green-300">{applyResult.created} cards created, {applyResult.reused} already existed, {applyResult.queued} ready cards queued.</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 p-5 dark:border-gray-700">
          <a href={PRD_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-purple-600 underline dark:text-purple-400">TaskMaster documentation</a>
          <div className="flex items-center gap-2">
            {step === 'edit' && <label className="mr-2 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><input type="checkbox" checked={startReady} onChange={(event) => setStartReady(event.target.checked)} />Queue ready tasks</label>}
            {step === 'edit' && <button onClick={() => setStep('generate')} className="flex items-center gap-1 rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600"><ChevronLeft className="h-4 w-4" />Back</button>}
            {step === 'generate' && <button onClick={() => void generate()} disabled={busy} className="flex items-center gap-2 rounded bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Generate graph<ChevronRight className="h-4 w-4" /></button>}
            {step === 'edit' && <button onClick={() => void apply()} disabled={busy || !graph?.tasks.length} className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Apply to Kanban<ChevronRight className="h-4 w-4" /></button>}
            {step === 'apply' && <button onClick={resetAndClose} className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Done</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
