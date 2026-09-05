import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Loader2, Trash2 } from 'lucide-react';

import { Badge, Button, Input } from '../../../../../../../shared/view/ui';
import { api } from '../../../../../../../utils/api';
import { copyTextToClipboard } from '../../../../../../../utils/clipboard';

/**
 * Antigravity's setup pane.
 *
 * Antigravity is the only provider CloudCLI installs itself and the only one
 * whose sign-in runs through ACP `authenticate` rather than a CLI `login`, so it
 * needs controls no other agent has:
 *
 *  - Install / reinstall / remove the managed runtime, with live progress
 *    (the archive is large enough that a spinner alone reads as a hang);
 *  - Sign in with Google, with the consent URL shown so it can be copied to a
 *    browser on another machine;
 *  - a paste box for the `http://127.0.0.1…` URL the browser lands on, which is
 *    the only way to finish sign-in when CloudCLI runs on a remote host;
 *  - an explicit binary-path override, reported back as resolved or invalid.
 */

type RuntimeBinary = {
  path: string | null;
  source: 'override' | 'managed' | 'path' | null;
  error: string | null;
};

type RuntimeState = {
  version: string;
  platformKey: string | null;
  supported: boolean;
  installed: boolean;
  pinned: boolean;
  installDir: string;
  binary: RuntimeBinary;
  config: { binaryPath: string; authMethod: string };
  authMethods: string[];
};

type LoginState = {
  status: 'pending' | 'succeeded' | 'failed';
  methodId: string;
  url: string | null;
  error: string | null;
} | null;

type InstallProgress =
  | { phase: 'download'; receivedBytes: number; totalBytes: number; percent: number }
  | { phase: 'verify' | 'extract' | 'probe' | 'done'; message: string };

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const describeProgress = (progress: InstallProgress): string => {
  if (progress.phase === 'download') {
    return `Downloading… ${progress.percent}% (${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)})`;
  }
  return progress.message;
};

export default function AntigravityRuntimePanel({
  onStatusChange,
  authenticated = false,
}: {
  onStatusChange?: () => void;
  authenticated?: boolean;
}) {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [returnUrl, setReturnUrl] = useState('');
  const [binaryPath, setBinaryPath] = useState('');
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  const loadRuntime = useCallback(async () => {
    try {
      const response = await api.antigravity.runtime();
      const payload = await response.json();
      const data = payload?.data as RuntimeState | undefined;
      if (data) {
        setRuntime(data);
        setBinaryPath(data.config.binaryPath);
      }
    } catch (loadError) {
      setError((loadError as Error)?.message || 'Could not read Antigravity runtime state.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuntime();
  }, [loadRuntime]);

  // While a sign-in is pending the outcome only arrives when the browser
  // round-trip finishes, so poll until it settles.
  useEffect(() => {
    if (login?.status !== 'pending') {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = window.setInterval(async () => {
      try {
        const response = await api.antigravity.loginState();
        const payload = await response.json();
        const state = payload?.data as LoginState;
        if (!state) return;
        setLogin(state);
        if (state.status === 'succeeded') {
          await loadRuntime();
          onStatusChange?.();
        }
      } catch {
        // A transient poll failure is not the sign-in's outcome; keep polling.
      }
    }, 2000);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [login?.status, loadRuntime, onStatusChange]);

  const install = useCallback(async (force: boolean) => {
    setInstalling(true);
    setError(null);
    setProgress('Starting install…');
    try {
      const response = await api.antigravity.install(force);
      const body = response.body;
      if (!body) {
        throw new Error('The server did not return an install progress stream.');
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let failure: string | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; keep any partial tail.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(dataMatch[1]);
          } catch {
            continue;
          }
          if (eventMatch[1] === 'progress') {
            setProgress(describeProgress(data as unknown as InstallProgress));
          } else if (eventMatch[1] === 'error') {
            failure = typeof data.error === 'string' ? data.error : 'Install failed.';
          } else if (eventMatch[1] === 'done') {
            setProgress('Runtime installed.');
          }
        }
      }
      if (failure) setError(failure);
      await loadRuntime();
      onStatusChange?.();
    } catch (installError) {
      setError((installError as Error)?.message || 'Antigravity install failed.');
    } finally {
      setInstalling(false);
    }
  }, [loadRuntime, onStatusChange]);

  const uninstall = useCallback(async () => {
    setError(null);
    try {
      await api.antigravity.uninstall();
      await loadRuntime();
      onStatusChange?.();
    } catch (removeError) {
      setError((removeError as Error)?.message || 'Could not remove the Antigravity runtime.');
    }
  }, [loadRuntime, onStatusChange]);

  const startSignIn = useCallback(async () => {
    setSigningIn(true);
    setError(null);
    try {
      const response = await api.antigravity.startLogin(runtime?.config.authMethod);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || 'Could not start Google sign-in.');
      }
      setLogin(payload?.data as LoginState);
    } catch (loginError) {
      setError((loginError as Error)?.message || 'Could not start Google sign-in.');
    } finally {
      setSigningIn(false);
    }
  }, [runtime?.config.authMethod]);

  const submitReturnUrl = useCallback(async () => {
    setError(null);
    try {
      const response = await api.antigravity.submitReturnUrl(returnUrl.trim());
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || 'Could not complete sign-in.');
      }
      setLogin(payload?.data as LoginState);
      setReturnUrl('');
      await loadRuntime();
      onStatusChange?.();
    } catch (callbackError) {
      setError((callbackError as Error)?.message || 'Could not complete sign-in.');
    }
  }, [returnUrl, loadRuntime, onStatusChange]);

  const saveBinaryPath = useCallback(async () => {
    setError(null);
    try {
      const response = await api.antigravity.saveConfig({ binaryPath: binaryPath.trim() });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || 'Could not save the binary path.');
      }
      // The server reports whether the new path actually resolves, so a typo
      // surfaces here instead of at the start of the next chat turn.
      const binary = payload?.data?.binary as RuntimeBinary | undefined;
      if (binary?.error) setError(binary.error);
      await loadRuntime();
      onStatusChange?.();
    } catch (saveError) {
      setError((saveError as Error)?.message || 'Could not save the binary path.');
    }
  }, [binaryPath, loadRuntime, onStatusChange]);

  const copyLink = useCallback(async () => {
    if (!login?.url) return;
    if (await copyTextToClipboard(login.url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [login?.url]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading Antigravity runtime state…
      </div>
    );
  }

  if (!runtime) {
    return <div className="text-sm text-destructive">{error || 'Antigravity runtime state is unavailable.'}</div>;
  }

  return (
    <div className="space-y-5 border-t border-border/50 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-foreground">Managed runtime</div>
          <div className="text-sm text-muted-foreground">
            Version {runtime.version}
            {runtime.platformKey ? ` · ${runtime.platformKey}` : ''}
          </div>
        </div>
        {runtime.installed ? (
          <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
            Installed
          </Badge>
        ) : (
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
            Not installed
          </Badge>
        )}
      </div>

      {!runtime.supported && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          Google does not publish an Antigravity runtime for this machine. Apple Silicon Macs, Linux (x64/arm64) and
          Windows (x64/arm64) are supported.
        </div>
      )}

      {runtime.supported && !runtime.pinned && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          This CloudCLI build has no verified download pin (SHA-256 + size) for the Antigravity {runtime.version}
          {' '}runtime on {runtime.platformKey}. Installing without one is refused. Set
          {' '}<code>CLOUDCLI_ANTIGRAVITY_MANIFEST</code> to a JSON file with the official URL, SHA-256 and byte size,
          or point the binary path below at a runtime you installed yourself.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void install(false)} disabled={installing || !runtime.supported || !runtime.pinned}>
          {installing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          {runtime.installed ? 'Repair install' : 'Install'}
        </Button>
        {runtime.installed && (
          <>
            <Button type="button" variant="outline" onClick={() => void install(true)} disabled={installing}>
              Reinstall
            </Button>
            <Button type="button" variant="ghost" onClick={() => void uninstall()} disabled={installing}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </>
        )}
      </div>

      {installing && <div className="text-sm text-muted-foreground">{progress}</div>}
      {!installing && progress && <div className="text-sm text-muted-foreground">{progress}</div>}

      <div className="space-y-2">
        <div className="font-medium text-foreground">Sign in with Google</div>
        <p className="text-sm text-muted-foreground">
          Antigravity uses your personal Google account ({runtime.config.authMethod}). CloudCLI never falls back to a
          Gemini API key, so nothing here can put you on metered API billing.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void startSignIn()}
            disabled={signingIn || (!runtime.installed && !runtime.binary.path)}
          >
            {signingIn ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
            Sign in with Google
          </Button>
          {login?.status === 'pending' && <span className="text-sm text-muted-foreground">Waiting for the browser…</span>}
          {authenticated && (
            <span className="text-sm text-green-700 dark:text-green-400">Signed in.</span>
          )}
          {login?.status === 'succeeded' && !authenticated && (
            <span className="text-sm text-amber-800 dark:text-amber-200">
              Sign-in completed, but Connection Status has not refreshed yet. Click the refresh icon above; if it still shows disconnected, run Sign in with Google again.
            </span>
          )}
        </div>

        {login?.url && (
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Consent URL</div>
            <div className="break-all font-mono text-xs text-foreground">{login.url}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void copyLink()}>
                {copied ? <Check className="mr-2 h-3.5 w-3.5" /> : <Copy className="mr-2 h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <a
                className="text-sm text-primary underline"
                href={login.url}
                target="_blank"
                rel="noreferrer"
              >
                Open in browser
              </a>
            </div>
          </div>
        )}

        {(login?.status === 'pending' || Boolean(login?.url)) && (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="font-medium text-foreground">Finishing on a remote CloudCLI</div>
            <p className="text-sm text-muted-foreground">
              Google redirects your browser to a <code>http://127.0.0.1…</code> address that only exists on the machine
              running the agent. If that is not the machine you are browsing from, paste the full redirect URL here and
              CloudCLI will replay it locally.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={returnUrl}
                onChange={(event) => setReturnUrl(event.target.value)}
                placeholder="http://127.0.0.1:PORT/?code=…"
                className="flex-1 min-w-[16rem] font-mono text-xs"
              />
              <Button type="button" size="sm" onClick={() => void submitReturnUrl()} disabled={!returnUrl.trim()}>
                Complete sign-in
              </Button>
            </div>
          </div>
        )}

        {login?.status === 'failed' && login.error && (
          <div className="text-sm text-destructive">{login.error}</div>
        )}
      </div>

      <div className="space-y-2">
        <div className="font-medium text-foreground">Binary path override</div>
        <p className="text-sm text-muted-foreground">
          Leave empty to use the managed runtime (then PATH). A non-empty path wins outright — if it is not an
          executable file, CloudCLI reports an error instead of silently falling back.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={binaryPath}
            onChange={(event) => setBinaryPath(event.target.value)}
            placeholder={runtime.installDir}
            className="flex-1 min-w-[16rem] font-mono text-xs"
          />
          <Button type="button" size="sm" variant="outline" onClick={() => void saveBinaryPath()}>
            Save
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          {runtime.binary.error
            ? <span className="text-destructive">{runtime.binary.error}</span>
            : `Resolved from ${runtime.binary.source}: ${runtime.binary.path}`}
        </div>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}
    </div>
  );
}
