import { useEffect, useState } from 'react';
import { Database, FolderArchive, Loader2, MessagesSquare, Play, Save } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import BackupProjectExclusionsField from '../BackupProjectExclusionsField';
import { useBackupProjectOptions } from '../../hooks/useBackupProjectOptions';

type BackupConfig = {
  enabled: boolean;
  schedule: string;
  destination: string;
  includeDatabase: boolean;
  includeCodebase: boolean;
  includeAgentConversations: boolean;
  excludedProjectPaths: string[];
  includeProjects: boolean;
  projectPaths: string[];
  retention: number;
};

const DEFAULT_CONFIG: BackupConfig = {
  enabled: false, schedule: '0 2 * * *', destination: '~/.cloudcli/backups',
  includeDatabase: true, includeCodebase: true,
  includeAgentConversations: true, excludedProjectPaths: [],
  includeProjects: false, projectPaths: [], retention: 7,
};

export default function BackupsSettingsTab() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const { projects: projectOptions, isLoading: projectOptionsLoading, loadError: projectOptionsError } = useBackupProjectOptions();
  const [history, setHistory] = useState<Array<{ status: string; reason: string; filename?: string; error?: string; completedAt: string; warnings?: string[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/settings/backups');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load backup settings');
      setConfig({ ...DEFAULT_CONFIG, ...body.config });
      setHistory(Array.isArray(body.history) ? body.history : []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load backup settings'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    setSaving(true); setMessage(''); setError('');
    try {
      const response = await authenticatedFetch('/api/settings/backups', { method: 'PUT', body: JSON.stringify(config) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save backup settings');
      setConfig({ ...DEFAULT_CONFIG, ...body.config }); setMessage('Backup settings saved.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save backup settings'); }
    finally { setSaving(false); }
  };

  const runNow = async () => {
    setRunning(true); setMessage(''); setError('');
    try {
      const response = await authenticatedFetch('/api/settings/backups/run', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Backup failed');
      setMessage(`Backup created: ${body.result.filename}`);
      void load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Backup failed'); }
    finally { setRunning(false); }
  };

  const set = (patch: Partial<BackupConfig>) => setConfig((current) => ({ ...current, ...patch }));
  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading backup settings…</div>;

  return (
    <div className="space-y-8">
      <SettingsSection title="Backups" description="Create local, restorable snapshots of CloudCLI and its data on a cron schedule.">
        <SettingsCard divided>
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div><div className="text-sm font-medium">Enable scheduled backups</div><div className="mt-0.5 text-sm text-muted-foreground">The server runs this schedule while CloudCLI is running.</div></div>
            <SettingsToggle checked={config.enabled} onChange={(enabled) => set({ enabled })} ariaLabel="Enable scheduled backups" />
          </div>
          <label className="block px-4 py-4"><span className="text-sm font-medium">Cron schedule</span><span className="mt-0.5 block text-sm text-muted-foreground">Five-field cron, for example <code>0 2 * * *</code> for 2:00 AM daily.</span><input value={config.schedule} onChange={(event) => set({ schedule: event.target.value })} className="mt-3 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
          <label className="block px-4 py-4"><span className="text-sm font-medium">Destination</span><span className="mt-0.5 block text-sm text-muted-foreground">A local folder where timestamped ZIP snapshots are stored.</span><input value={config.destination} onChange={(event) => set({ destination: event.target.value })} className="mt-3 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
          <label className="block px-4 py-4"><span className="text-sm font-medium">Keep backups</span><span className="mt-0.5 block text-sm text-muted-foreground">Older snapshots are removed after this many successful backups.</span><input type="number" min={1} max={100} value={config.retention} onChange={(event) => set({ retention: Number(event.target.value) })} className="mt-3 h-10 w-28 rounded-lg border border-border bg-background px-3 text-sm" /></label>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Snapshot contents" description="Choose what should be included in each archive.">
        <SettingsCard divided>
          <div className="flex items-center justify-between px-4 py-4"><div className="flex items-center gap-3"><Database className="h-4 w-4 text-muted-foreground" /><div><div className="text-sm font-medium">CloudCLI database</div><div className="text-sm text-muted-foreground">SQLite database and its WAL sidecars.</div></div></div><SettingsToggle checked={config.includeDatabase} onChange={(includeDatabase) => set({ includeDatabase })} ariaLabel="Include database" /></div>
          <div className="flex items-center justify-between px-4 py-4"><div className="flex items-center gap-3"><FolderArchive className="h-4 w-4 text-muted-foreground" /><div><div className="text-sm font-medium">CloudCLI codebase</div><div className="text-sm text-muted-foreground">Source/config files, excluding dependencies, build output, Git metadata, and temp files.</div></div></div><SettingsToggle checked={config.includeCodebase} onChange={(includeCodebase) => set({ includeCodebase })} ariaLabel="Include codebase" /></div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Agent conversations" description="Back up provider-native session/conversation data (Claude, Codex, Cursor, and every other connected agent) for your registered projects.">
        <SettingsCard divided>
          <div className="flex items-center justify-between px-4 py-4">
            <div className="flex items-center gap-3">
              <MessagesSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Include agent conversations</div>
                <div className="text-sm text-muted-foreground">Enabled by default. Independent of the CloudCLI database/codebase toggles above.</div>
              </div>
            </div>
            <SettingsToggle checked={config.includeAgentConversations} onChange={(includeAgentConversations) => set({ includeAgentConversations })} ariaLabel="Include agent conversations" />
          </div>
          {config.includeAgentConversations && (
            <div className="px-4 py-4">
              <BackupProjectExclusionsField
                excludedPaths={config.excludedProjectPaths}
                options={projectOptions}
                optionsLoading={projectOptionsLoading}
                optionsError={projectOptionsError}
                onChange={(excludedProjectPaths) => set({ excludedProjectPaths })}
              />
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Additional project source folders" description="A separate, optional set of arbitrary source folders (not agent conversation data) to include verbatim in the archive.">
        <SettingsCard divided>
          <div className="flex items-center justify-between px-4 py-4"><div><div className="text-sm font-medium">Project source folders</div><div className="text-sm text-muted-foreground">Include the additional paths listed below.</div></div><SettingsToggle checked={config.includeProjects} onChange={(includeProjects) => set({ includeProjects })} ariaLabel="Include project source folders" /></div>
          <label className="block px-4 py-4"><span className="text-sm font-medium">Folder paths</span><span className="mt-0.5 block text-sm text-muted-foreground">One absolute path per line.</span><textarea value={config.projectPaths.join('\n')} onChange={(event) => set({ projectPaths: event.target.value.split('\n').map((value) => value.trim()).filter(Boolean) })} rows={3} className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
        </SettingsCard>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-3"><Button onClick={() => void save()} disabled={saving}><Save className="mr-2 h-4 w-4" />{saving ? 'Saving…' : 'Save settings'}</Button><Button variant="outline" onClick={() => void runNow()} disabled={running}><Play className="mr-2 h-4 w-4" />{running ? 'Creating backup…' : 'Run backup now'}</Button>{message && <span className="text-sm text-emerald-600">{message}</span>}{error && <span className="text-sm text-destructive">{error}</span>}</div>
      <SettingsSection title="Recent runs" description="The server keeps the latest 20 backup attempts.">
        <SettingsCard divided>
          {history.length === 0 ? <div className="px-4 py-5 text-sm text-muted-foreground">No backups have run yet.</div> : history.slice(0, 5).map((entry) => (
            <div key={`${entry.completedAt}-${entry.filename || entry.error}`} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className={entry.status === 'success' ? 'text-emerald-600' : 'text-destructive'}>{entry.status === 'success' ? entry.filename : entry.error}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{new Date(entry.completedAt).toLocaleString()}</span>
              </div>
              {entry.warnings && entry.warnings.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-amber-600">
                  {entry.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
