import { useEffect, useState } from 'react';
import { Check, Save } from 'lucide-react';

import type { Bot } from '../../types';
import Toggle from '../../ui/Toggle';
import { Button } from '../../../../shared/view/ui';
import { CRON_PRESETS, cronSummary, presetForCron, validateCron } from '../detail/cron';

export default function TriggersTab({ bot, onSave }: { bot: Bot; onSave: (patch: { schedule_cron: string | null; enabled: boolean; permission_mode: string }) => Promise<void> }) {
  const [cron, setCron] = useState(bot.schedule_cron ?? '');
  const [enabled, setEnabled] = useState(bot.enabled);
  const [permission, setPermission] = useState(bot.permission_mode || 'default');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { setCron(bot.schedule_cron ?? ''); setEnabled(bot.enabled); setPermission(bot.permission_mode || 'default'); }, [bot.enabled, bot.permission_mode, bot.schedule_cron]);
  const error = validateCron(cron);
  const save = async () => { if (error) { setNote(error); return; } try { await onSave({ schedule_cron: cron.trim() || null, enabled, permission_mode: permission }); setNote('Trigger saved.'); } catch (nextError) { setNote(nextError instanceof Error ? nextError.message : 'Unable to save trigger.'); } };
  return <div className="max-w-3xl space-y-6 p-4 sm:p-6">
    <div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Trigger</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Choose a common cadence or enter a five-field cron expression. Manual-only bots never schedule automatically.</p></div>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CRON_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => setCron(preset.cron ?? '')} className={`rounded-xl border p-3 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${presetForCron(cron)?.id === preset.id ? 'border-primary/50 bg-primary/5' : 'border-border/70 bg-card hover:bg-accent/30'}`}><span className="flex items-center gap-2 font-medium">{presetForCron(cron)?.id === preset.id ? <Check className="h-3.5 w-3.5 text-primary" /> : <span className="h-3.5 w-3.5" />}{preset.label}</span><span className="mt-1 block text-[10px] text-muted-foreground">{preset.description}</span></button>)}</div>
    <label className="block rounded-xl border border-border/70 bg-card p-4"><span className="text-xs font-semibold">Custom cron</span><input aria-label="Cron schedule" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />{error ? <span className="mt-2 block text-xs text-destructive" role="alert">{error}</span> : <span className="mt-2 block text-xs text-muted-foreground">{cronSummary(cron)}</span>}</label>
    <label className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-4"><Toggle checked={enabled} onChange={setEnabled} label="Enable bot trigger" /><span><span className="block text-xs font-medium">Enabled</span><span className="block text-[10px] text-muted-foreground">Paused bots do not schedule new ticks.</span></span></label>
    <label className="block rounded-xl border border-border/70 bg-card p-4"><span className="text-xs font-semibold">Permission mode</span><select value={permission} onChange={(event) => setPermission(event.target.value)} className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-xs outline-none focus:border-primary"><option value="default">Default</option><option value="acceptEdits">Accept edits</option><option value="bypassPermissions">Bypass permissions</option></select><span className="mt-2 block text-[10px] leading-4 text-muted-foreground">This controls the agent session. MCP tool policy still decides which individual capabilities can run.</span></label>
    <div className="flex items-center gap-3"><Button onClick={() => void save()} disabled={Boolean(error)}><Save className="h-3.5 w-3.5" />Save trigger</Button>{note ? <span className="text-xs text-muted-foreground" role="status">{note}</span> : null}</div>
  </div>;
}
