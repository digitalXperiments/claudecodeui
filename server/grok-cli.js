import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from './shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

let activeGrokProcesses = new Map(); // Track active processes by session ID

async function spawnGrok(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, model, effort, sessionSummary, permissionMode = 'bypassPermissions', toolsSettings } = options;
    const resolvedModel = await providerModelsService.resolveResumeModel('grok', sessionId, model);
    const catalog = (await providerModelsService.getProviderModels('grok')).models;
    const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
    const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
    const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
      ? effort
      : undefined;
    let capturedSessionId = sessionId; // Only known for certain once the `end` event arrives
    let sessionCreatedSent = false;
    let settled = false;
    let completeSent = false;

    // Grok's own `--permission-mode` vocabulary (default, acceptEdits, auto,
    // dontAsk, bypassPermissions, plan) lines up directly with cloudcli's, so
    // the selected mode is passed straight through rather than hardcoded.
    const baseArgs = ['--output-format', 'streaming-json', '--permission-mode', permissionMode];

    // Real `ToolPrefix(glob_pattern)` rules from the Grok settings tab (e.g.
    // "Bash(npm*)" / "Bash(sudo*)") - verified live that --allow/--deny
    // compose cleanly alongside --permission-mode/-r/-m/--reasoning-effort.
    // Deny takes precedence over allow per Grok's own docs.
    for (const rule of toolsSettings?.allowedCommands || []) {
      if (typeof rule === 'string' && rule.trim()) {
        baseArgs.push('--allow', rule.trim());
      }
    }
    for (const rule of toolsSettings?.disallowedCommands || []) {
      if (typeof rule === 'string' && rule.trim()) {
        baseArgs.push('--deny', rule.trim());
      }
    }

    if (sessionId) {
      baseArgs.push('-r', sessionId);
    }

    if (command && command.trim()) {
      // grok is a plain binary (no Windows .cmd shim concerns known today), but
      // flattening keeps this consistent with the other CLI adapters.
      baseArgs.push('-p', flattenPromptForWindowsShell(command));
    }

    if (resolvedModel) {
      baseArgs.push('-m', resolvedModel);
    }

    if (resolvedEffort) {
      baseArgs.push('--reasoning-effort', resolvedEffort);
    }

    const workingDir = cwd || projectPath || process.cwd();
    const processKey = capturedSessionId || Date.now().toString();

    const settleOnce = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }
      terminalNotificationSent = true;

      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'grok',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'grok',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Grok CLI exited with code ${code}`
      });
    };

    const captureSessionIdIfNeeded = (newSessionId) => {
      if (!newSessionId || capturedSessionId) {
        return;
      }

      capturedSessionId = newSessionId;
      if (processKey !== capturedSessionId) {
        activeGrokProcesses.delete(processKey);
        activeGrokProcesses.set(capturedSessionId, grokProcess);
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      // Grok's streaming-json mode only reveals the session id on the
      // terminal `end` event (no early `system/init`-style event like
      // Cursor/Codex), so `session_created` unavoidably fires late for brand
      // new sessions - the frontend will only navigate once the run finishes.
      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, cwd: workingDir, sessionId: capturedSessionId, provider: 'grok' }));
      }
    };

    const processGrokOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        // Non-JSON output (should not normally happen in streaming-json mode)
        // is still surfaced as a stream delta rather than silently dropped.
        const normalized = sessionsService.normalizeMessage('grok', line, capturedSessionId || sessionId || null);
        for (const msg of normalized) ws.send(msg);
        return;
      }

      switch (response.type) {
        case 'text':
        case 'thought': {
          const normalized = sessionsService.normalizeMessage('grok', response, capturedSessionId || sessionId || null);
          for (const msg of normalized) ws.send(msg);
          break;
        }

        case 'end': {
          captureSessionIdIfNeeded(response.sessionId);
          if (!completeSent) {
            completeSent = true;
            ws.send(createCompleteMessage({
              provider: 'grok',
              sessionId: capturedSessionId || sessionId || null,
              exitCode: response.stopReason === 'EndTurn' ? 0 : 1,
            }));
          }
          break;
        }

        case 'error': {
          captureSessionIdIfNeeded(response.sessionId);
          ws.send(createNormalizedMessage({ kind: 'error', content: response.message || 'Grok CLI error', sessionId: capturedSessionId || sessionId || null, provider: 'grok' }));
          break;
        }

        default:
          // Grok documents `max_turns_reached` / `auto_compact_*` as
          // additional, non-exhaustive event types - ignore anything unknown
          // rather than surfacing raw internal events to the UI.
          break;
      }
    };

    const grokProcess = spawnFunction('grok', baseArgs, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    activeGrokProcesses.set(processKey, grokProcess);

    // Bounds an otherwise-unbounded wait: a grok invocation that hangs (e.g.
    // blocked waiting on a lock file another process is holding - the actual
    // cause of a real production incident) previously had nothing to make it
    // give up, leaving the chat request (and the underlying OS process)
    // stuck indefinitely. 20 minutes is generous for a long agentic turn but
    // guarantees this eventually self-heals instead of needing a manual
    // server restart.
    const RUN_TIMEOUT_MS = 20 * 60 * 1000;
    const runTimeout = setTimeout(() => {
      console.error(`Grok CLI run timed out after ${RUN_TIMEOUT_MS}ms, terminating.`);
      grokProcess.kill('SIGTERM');
      setTimeout(() => {
        if (grokProcess.exitCode === null && grokProcess.signalCode === null) {
          try {
            grokProcess.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }, 5000);
    }, RUN_TIMEOUT_MS);

    grokProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      stdoutLineBuffer += rawOutput;
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';
      completeLines.forEach((line) => processGrokOutputLine(line.trim()));
    });

    grokProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      console.error('Grok CLI stderr:', stderrText);
      ws.send(createNormalizedMessage({ kind: 'error', content: stderrText, sessionId: capturedSessionId || sessionId || null, provider: 'grok' }));
    });

    grokProcess.on('close', async (code) => {
      clearTimeout(runTimeout);
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGrokProcesses.delete(finalSessionId);

      if (stdoutLineBuffer.trim()) {
        processGrokOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      if (!completeSent && !grokProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'grok', sessionId: finalSessionId, exitCode: code }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        settleOnce(() => resolve());
      } else {
        notifyTerminalState({ code });
        settleOnce(() => reject(new Error(`Grok CLI exited with code ${code}`)));
      }
    });

    grokProcess.on('error', async (error) => {
      clearTimeout(runTimeout);
      console.error('Grok CLI process error:', error);

      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeGrokProcesses.delete(finalSessionId);

      const installed = await providerAuthService.isProviderInstalled('grok');
      const errorContent = !installed
        ? 'Grok CLI is not installed. Please install it from https://x.ai'
        : error.message;

      ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'grok' }));
      if (!completeSent && !grokProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'grok', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
      }
      notifyTerminalState({ error });

      settleOnce(() => reject(error));
    });

    grokProcess.stdin.end();
  });
}

function abortGrokSession(sessionId) {
  const process = activeGrokProcesses.get(sessionId);
  if (process) {
    console.log(`Aborting Grok session: ${sessionId}`);
    process.aborted = true;
    process.kill('SIGTERM');
    // See the same escalation in the timeout handler further up: SIGTERM is
    // not guaranteed to actually terminate a process blocked on a lock or
    // syscall, and a survivor here would keep running (and keep holding
    // whatever it had open) invisibly after cloudcli has already forgotten
    // about it.
    setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) {
        try {
          process.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, 5000);
    activeGrokProcesses.delete(sessionId);
    return true;
  }
  return false;
}

function isGrokSessionActive(sessionId) {
  return activeGrokProcesses.has(sessionId);
}

function getActiveGrokSessions() {
  return Array.from(activeGrokProcesses.keys());
}

export {
  spawnGrok,
  abortGrokSession,
  isGrokSessionActive,
  getActiveGrokSessions
};
