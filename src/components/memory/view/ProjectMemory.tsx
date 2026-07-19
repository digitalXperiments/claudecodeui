import { useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  Database,
  FolderTree,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { Badge, Button, Input } from '../../../shared/view/ui';
import { useObsidianSettings } from '../hooks/useObsidianSettings';
import { useProjectMemory } from '../hooks/useProjectMemory';
import type { MemoryProject } from '../types';

type ProjectMemoryProps = {
  currentProjects: MemoryProject[];
};

type ProjectTarget = {
  projectId: string;
  displayName: string;
  path: string;
};

const createProjectTargets = (projects: MemoryProject[]): ProjectTarget[] => {
  const seen = new Set<string>();
  return projects.reduce<ProjectTarget[]>((acc, project) => {
    const projectPath = project.fullPath || project.path || '';
    if (!projectPath || seen.has(projectPath)) {
      return acc;
    }
    seen.add(projectPath);
    acc.push({
      projectId: project.projectId,
      displayName: project.displayName || project.projectId,
      path: projectPath,
    });
    return acc;
  }, []);
};

const defaultVaultFolder = (displayName: string): string => {
  const slug = displayName.trim().replace(/[/\\]+/g, '-');
  return `Projects/${slug || 'project'}`;
};

export default function ProjectMemory({ currentProjects }: ProjectMemoryProps) {
  const projectTargets = useMemo(() => createProjectTargets(currentProjects), [currentProjects]);
  const [selectedPath, setSelectedPath] = useState<string | null>(projectTargets[0]?.path ?? null);

  useEffect(() => {
    setSelectedPath((current) => {
      if (current && projectTargets.some((project) => project.path === current)) {
        return current;
      }
      return projectTargets[0]?.path ?? null;
    });
  }, [projectTargets]);

  const selectedProject = projectTargets.find((project) => project.path === selectedPath) ?? null;

  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    saveStatus: settingsSaveStatus,
    save: saveSettings,
  } = useObsidianSettings();

  const {
    status,
    isLoading: memoryLoading,
    isBusy,
    error: memoryError,
    enable,
    disable,
    rescaffold,
  } = useProjectMemory({ workspacePath: selectedPath });

  // Local editable copies of the global settings form.
  const [vaultPath, setVaultPath] = useState('');
  const [restProtocol, setRestProtocol] = useState<'http' | 'https'>('http');
  const [restHost, setRestHost] = useState('127.0.0.1');
  const [restPort, setRestPort] = useState('27123');
  const [restApiKey, setRestApiKey] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    setVaultPath(settings.vaultPath);
    setRestProtocol(settings.restProtocol);
    setRestHost(settings.restHost);
    setRestPort(String(settings.restPort));
    setRestApiKey(settings.restApiKey);
  }, [settings]);

  const [vaultFolder, setVaultFolder] = useState('');
  useEffect(() => {
    if (status?.vaultFolder) {
      setVaultFolder(status.vaultFolder);
    } else if (selectedProject) {
      setVaultFolder(defaultVaultFolder(selectedProject.displayName));
    }
  }, [status?.vaultFolder, selectedProject]);

  const [actionError, setActionError] = useState<string | null>(null);

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    setActionError(null);
    try {
      await saveSettings({
        vaultPath,
        restProtocol,
        restHost,
        restPort: Number(restPort) || 0,
        restApiKey,
      });
    } catch {
      // error surfaced via settingsError
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleEnable = async () => {
    setActionError(null);
    try {
      await enable(vaultFolder);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to enable memory');
    }
  };

  const handleDisable = async () => {
    setActionError(null);
    try {
      await disable();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to disable memory');
    }
  };

  const handleRescaffold = async () => {
    setActionError(null);
    try {
      await rescaffold();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to scaffold vault');
    }
  };

  const enabled = Boolean(status?.enabled);

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/20 text-muted-foreground">
          <BrainCircuit className="h-4 w-4" strokeWidth={1.7} />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-medium text-foreground">Memory (Obsidian)</h3>
          <p className="text-sm text-muted-foreground">
            Give each project a persistent second brain in Obsidian. Every agent reads it for context and records its
            proceedings, so knowledge compounds across sessions.
          </p>
        </div>
      </div>

      {/* Global Obsidian connection settings */}
      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">Obsidian connection</h4>
          {settings.configured ? (
            <Badge variant="outline" className="rounded-full border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300">
              Configured
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-full border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
              Not configured
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Shared across all projects. The vault path is used to scaffold project folders on disk. The Local REST API
          credentials (from Obsidian&apos;s Local REST API plugin) let running agents read and write notes.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">Vault path (absolute)</span>
            <Input
              value={vaultPath}
              onChange={(event) => setVaultPath(event.target.value)}
              placeholder="/Users/you/Obsidian/MyVault"
              className="h-9 w-full font-mono text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">REST protocol</span>
            <select
              value={restProtocol}
              onChange={(event) => setRestProtocol(event.target.value === 'https' ? 'https' : 'http')}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="http">http (port 27123)</option>
              <option value="https">https (port 27124)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">REST host</span>
            <Input value={restHost} onChange={(event) => setRestHost(event.target.value)} placeholder="127.0.0.1" className="h-9 w-full" />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">REST port</span>
            <Input value={restPort} onChange={(event) => setRestPort(event.target.value)} placeholder="27123" className="h-9 w-full" />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">REST API key</span>
            <Input
              type="password"
              value={restApiKey}
              onChange={(event) => setRestApiKey(event.target.value)}
              placeholder="Local REST API plugin key"
              className="h-9 w-full font-mono text-xs"
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" size="sm" onClick={() => void handleSaveSettings()} disabled={isSavingSettings || settingsLoading}>
            {isSavingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Save connection
          </Button>
          {settingsSaveStatus === 'success' && (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved.</span>
          )}
          {settingsError && <span className="text-xs text-red-600 dark:text-red-400">{settingsError}</span>}
        </div>
      </section>

      {/* Per-project memory */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">Project memory</h4>
        </div>

        {projectTargets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center text-sm text-muted-foreground">
            Open a project to configure its memory.
          </div>
        ) : (
          <>
            {projectTargets.length > 1 && (
              <select
                value={selectedPath ?? ''}
                onChange={(event) => setSelectedPath(event.target.value)}
                aria-label="Select project"
                className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm text-foreground sm:max-w-xs"
              >
                {projectTargets.map((project) => (
                  <option key={project.path} value={project.path}>{project.displayName}</option>
                ))}
              </select>
            )}

            {selectedProject && (
              <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
                <code className="block whitespace-normal break-all text-xs text-foreground">{selectedProject.path}</code>
              </div>
            )}

            {!settings.configured && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
                Configure the Obsidian connection above before enabling memory for a project.
              </div>
            )}

            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Vault folder (relative to the vault)</span>
              <Input
                value={vaultFolder}
                onChange={(event) => setVaultFolder(event.target.value)}
                placeholder="Projects/my-project"
                disabled={enabled}
                className="h-9 w-full font-mono text-xs"
              />
            </label>

            {(actionError || memoryError) && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
                {actionError || memoryError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {enabled ? (
                <>
                  <Badge variant="outline" className="rounded-full border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Memory enabled
                  </Badge>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleRescaffold()} disabled={isBusy}>
                    {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Re-scaffold vault
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="text-red-600 hover:text-red-700" onClick={() => void handleDisable()} disabled={isBusy}>
                    Disable
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleEnable()}
                  disabled={isBusy || memoryLoading || !settings.configured || !vaultFolder.trim()}
                >
                  {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BrainCircuit className="h-4 w-4" />}
                  Enable memory
                </Button>
              )}
            </div>

            {enabled && status && status.providers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Installed for:</span>
                {status.providers.map((provider) => (
                  <Badge key={provider} variant="outline" className="rounded-full bg-background/70 text-xs">
                    {provider}
                  </Badge>
                ))}
                {status.skillInstalled && (
                  <Badge variant="outline" className="rounded-full bg-background/70 text-xs">Memory skill</Badge>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
