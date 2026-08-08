import { useState } from 'react';
import { Check, Loader2, Upload, X } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';

type ImportReport = {
  total: number;
  wouldCreate: number;
  created: Array<{ sourceId: string; title: string; taskId?: string }>;
  existing: Array<{ sourceId: string; title: string; taskId: string }>;
  dependencies: unknown[];
  dependencyWarnings: string[];
  warnings: string[];
};

type TaskMasterImportModalProps = {
  isOpen: boolean;
  projectId?: string;
  onClose: () => void;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

export default function TaskMasterImportModal({ isOpen, projectId, onClose }: TaskMasterImportModalProps) {
  const [path, setPath] = useState('.taskmaster/tasks/tasks.json');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const preview = async (dryRun: boolean) => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const boardResponse = await authenticatedFetch('/api/kanban/global');
      if (!boardResponse.ok) throw new Error(await readError(boardResponse, 'Could not load the Kanban board.'));
      const boardPayload = (await boardResponse.json()) as { board?: { board_id?: string } };
      const boardId = boardPayload.board?.board_id;
      if (!boardId) throw new Error('No Kanban board is available.');
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/taskmaster/import`, {
        method: 'POST',
        body: JSON.stringify({ boardId, path, dryRun }),
      });
      if (!response.ok) throw new Error(await readError(response, `Import failed (${response.status})`));
      const payload = (await response.json()) as { report?: ImportReport };
      setReport(payload.report ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'TaskMaster import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-5 dark:border-gray-700">
          <div className="flex items-center gap-2"><Upload className="h-5 w-5 text-blue-600" /><div><h3 className="font-semibold text-gray-900 dark:text-white">Import to Kanban</h3><p className="text-xs text-gray-500">TaskMaster is legacy; Kanban owns execution.</p></div></div>
          <button onClick={onClose} className="rounded p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-4 p-5">
          {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">{error}</div>}
          <label className="block text-sm text-gray-700 dark:text-gray-200">Source file<input value={path} onChange={(event) => setPath(event.target.value)} className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-white" /></label>
          <p className="text-xs text-gray-500">The path must stay inside the selected project. A dry-run is performed first and includes existing-card matches and dependency warnings.</p>
          {report && <div className="space-y-2 rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-700"><div className="flex items-center gap-2 font-medium text-gray-900 dark:text-white"><Check className="h-4 w-4 text-green-600" />{report.total} source tasks inspected</div><div className="grid grid-cols-3 gap-2 text-xs text-gray-600 dark:text-gray-300"><div><strong className="block text-lg text-gray-900 dark:text-white">{report.wouldCreate}</strong>to create</div><div><strong className="block text-lg text-gray-900 dark:text-white">{report.existing.length}</strong>already mapped</div><div><strong className="block text-lg text-gray-900 dark:text-white">{report.dependencies.length}</strong>dependencies</div></div>{(report.dependencyWarnings.length || report.warnings.length) ? <div className="text-xs text-amber-700 dark:text-amber-300">{[...report.dependencyWarnings, ...report.warnings].slice(0, 4).join(' ')}</div> : <div className="text-xs text-green-700 dark:text-green-300">No data-loss warnings in the preview.</div>}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 p-5 dark:border-gray-700"><button onClick={() => void preview(true)} disabled={busy} className="rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600">{busy && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}Preview</button><button onClick={() => void preview(false)} disabled={busy || !report} className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}Import</button></div>
      </div>
    </div>
  );
}
