import { useState } from 'react';
import { Download, Loader2, Trash2 } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotPurgeSelection } from '../../../../types/botRuntime';
import { ErrorLine, Panel, WarnLine } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import { PURGE_ITEMS, canPurge, exportFilename, purgePhrase, purgeSummary, selectedPurgeKeys } from './learningHelpers';

function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export everything the runtime holds for this bot, or permanently delete parts of it. */
export default function PrivacyPanel({ botId, title, onPurged }: { botId: string; title: string; onPurged: () => void }) {
  const action = useAsyncAction();
  const [selection, setSelection] = useState<BotPurgeSelection>({});
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const phrase = purgePhrase(title);
  const ready = canPurge(selection, typed, phrase);
  const selected = selectedPurgeKeys(selection);

  const exportData = () => void action.run('export', async () => {
    downloadJson(exportFilename(botId), await botRuntimeApi.privacy.exportBot(botId));
  });

  const purge = async () => {
    if (!ready) return;
    setResult(null);
    const ok = await action.run('purge', async () => {
      const counts = await botRuntimeApi.privacy.purge(botId, selection);
      setResult(purgeSummary(counts));
    });
    if (ok) {
      setSelection({});
      setTyped('');
      onPurged();
    }
  };

  return (
    <Panel title="Privacy" description="Take a copy of what this bot knows, or make it forget. Exports mask secrets in the bot's configuration.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="button" onClick={exportData} disabled={action.isBusy('export')}>{action.isBusy('export') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}Export as JSON</button>
          <p className="text-[11px] text-muted-foreground">Memories, episodes, events, conversation, proposals and skills.</p>
        </div>

        <form className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3" onSubmit={(event) => { event.preventDefault(); void purge(); }} aria-label="Purge bot data">
          <p className="text-xs font-semibold text-destructive">Delete data</p>
          <fieldset className="grid gap-1.5 sm:grid-cols-2">
            <legend className="sr-only">What to delete</legend>
            {PURGE_ITEMS.map((item) => (
              <label key={item.key} className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={selection[item.key] === true} onChange={(event) => setSelection((current) => ({ ...current, [item.key]: event.target.checked }))} />
                <span>{item.label}<span className="block text-[10px] text-muted-foreground">{item.description}</span></span>
              </label>
            ))}
          </fieldset>
          {selected.length > 0 ? (
            <>
              <WarnLine strong>This permanently deletes {selected.join(', ')} for this bot. It cannot be undone; export first if you may want it back.</WarnLine>
              <label className="block text-[11px] text-muted-foreground">
                Type <span className="font-mono font-semibold text-foreground">{phrase}</span> to confirm
                <input aria-label="Type the bot name to confirm" className="field mt-1 h-9" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} />
              </label>
            </>
          ) : null}
          <ErrorLine message={action.error} />
          {result ? <p role="status" className="text-xs text-foreground">{result}</p> : null}
          <div className="flex justify-end">
            <button type="submit" className="button border-destructive bg-destructive text-white hover:bg-destructive/90" disabled={!ready || action.isBusy('purge')}>{action.isBusy('purge') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}Delete selected data</button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
