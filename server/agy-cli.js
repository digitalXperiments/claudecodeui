import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from './shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// Where the Antigravity CLI records the most-recent conversation id per
// workspace. A brand-new `agy --print` run (no --conversation) creates a fresh
// conversation and writes its id here keyed by the working directory, which is
// how we recover the created session id (the plain-text stdout carries no id).
const AGY_LAST_CONVERSATIONS_PATH = path.join(
  os.homedir(),
  '.gemini',
  'antigravity-cli',
  'cache',
  'last_conversations.json',
);

let activeAgyProcesses = new Map(); // Track active processes by session ID

async function readLastConversationId(workingDir) {
  try {
    const content = await readFile(AGY_LAST_CONVERSATIONS_PATH, 'utf8');
    const parsed = JSON.parse(content);
    const id = parsed?.[workingDir];
    return typeof id === 'string' && id.trim() ? id : null;
  } catch {
    return null;
  }
}

async function spawnAgy(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, model, permissionMode = 'bypassPermissions', sessionSummary } = options;
    const resolvedModel = await providerModelsService.resolveResumeModel('agy', sessionId, model);
    let capturedSessionId = sessionId; // For resumes we already know it; for new runs it is read after close.
    let sessionCreatedSent = false;
    let settled = false;
    let completeSent = false;

    // Antigravity's headless mode prints a single response to stdout. Tools can
    // only run non-interactively when auto-approved, so the two supported
    // permission modes map to Antigravity's real flags: bypassPermissions ->
    // --dangerously-skip-permissions (auto-approve), plan -> --mode plan
    // (read-only planning). Anything else defaults to skipping permissions so a
    // spawned run never hangs on an approval prompt it cannot answer.
    const baseArgs = ['--model', resolvedModel];

    if (permissionMode === 'plan') {
      baseArgs.push('--mode', 'plan');
    } else if (permissionMode === 'acceptEdits') {
      // Auto-accept file edits; non-edit tool actions may still prompt (which
      // can stall a headless run) — surfaced to the user in the settings copy.
      baseArgs.push('--mode', 'accept-edits');
    } else {
      baseArgs.push('--dangerously-skip-permissions');
    }

    // Resume an existing Antigravity conversation by id; omitting the flag lets
    // the CLI create a new conversation whose id we read back after the run.
    if (sessionId) {
      baseArgs.push('--conversation', sessionId);
    }

    // The prompt is the VALUE of `--print` (aka `-p` / `--prompt`), not a
    // positional argument: `agy --print "<prompt>"` runs it once and prints the
    // response. It MUST come last so the flag consumes the prompt and not a
    // following option. Passing the prompt positionally instead makes `--print`
    // swallow the next flag and agy answers an empty prompt (a generic
    // greeting), so keep this as the final `--print <prompt>` pair.
    baseArgs.push('--print', flattenPromptForWindowsShell(command || ''));

    const workingDir = cwd || projectPath || process.cwd();
    const processKey = capturedSessionId || Date.now().toString();

    const settleOnce = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

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
          provider: 'agy',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'agy',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Antigravity CLI exited with code ${code}`,
      });
    };

    // Antigravity does not surface the new conversation id on stdout, so after a
    // brand-new run we read it from last_conversations.json (keyed by cwd) and
    // emit `session_created` late — the frontend navigates once the run ends,
    // mirroring how Grok reveals its id only on the terminal event.
    const captureNewSessionIdIfNeeded = async () => {
      if (sessionId || capturedSessionId) {
        return;
      }
      const newId = await readLastConversationId(workingDir);
      if (!newId) {
        return;
      }
      capturedSessionId = newId;
      if (processKey !== capturedSessionId) {
        activeAgyProcesses.delete(processKey);
        activeAgyProcesses.set(capturedSessionId, agyProcess);
      }
      if (typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      if (!sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          cwd: workingDir,
          sessionId: capturedSessionId,
          provider: 'agy',
        }));
      }
    };

    const agyProcess = spawnFunction('agy', baseArgs, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    activeAgyProcesses.set(processKey, agyProcess);

    // Bounds an otherwise-unbounded wait: an Antigravity run that hangs (e.g.
    // the language-server sidecar wedged on a lock) would otherwise leave the
    // chat request and OS process stuck indefinitely. 20 minutes is generous
    // for a long agentic turn but guarantees eventual self-heal. Kept aligned
    // with the CLI's own default --print-timeout of 5m for the model wait.
    const RUN_TIMEOUT_MS = 20 * 60 * 1000;
    const runTimeout = setTimeout(() => {
      console.error(`Antigravity CLI run timed out after ${RUN_TIMEOUT_MS}ms, terminating.`);
      agyProcess.kill('SIGTERM');
      setTimeout(() => {
        if (agyProcess.exitCode === null && agyProcess.signalCode === null) {
          try {
            agyProcess.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }, 5000);
    }, RUN_TIMEOUT_MS);

    agyProcess.stdout.on('data', (data) => {
      // Antigravity --print emits plain-text/markdown with no event schema, so
      // each chunk is forwarded verbatim as a streaming delta.
      const text = data.toString();
      if (!text) {
        return;
      }
      const normalized = sessionsService.normalizeMessage('agy', text, capturedSessionId || sessionId || null);
      for (const msg of normalized) ws.send(msg);
    });

    agyProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      // The Antigravity language server logs benign startup diagnostics (and a
      // transient "not logged in" line during cold start) to stderr; surface it
      // to the server console but do not treat it as a chat error.
      console.error('Antigravity CLI stderr:', stderrText);
    });

    agyProcess.on('close', async (code) => {
      clearTimeout(runTimeout);
      await captureNewSessionIdIfNeeded();

      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeAgyProcesses.delete(finalSessionId);
      activeAgyProcesses.delete(processKey);

      if (!completeSent && !agyProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'agy', sessionId: finalSessionId, exitCode: code }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        settleOnce(() => resolve());
      } else {
        notifyTerminalState({ code });
        settleOnce(() => reject(new Error(`Antigravity CLI exited with code ${code}`)));
      }
    });

    agyProcess.on('error', async (error) => {
      clearTimeout(runTimeout);
      console.error('Antigravity CLI process error:', error);

      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeAgyProcesses.delete(finalSessionId);
      activeAgyProcesses.delete(processKey);

      const installed = await providerAuthService.isProviderInstalled('agy');
      const errorContent = !installed
        ? 'Antigravity CLI (agy) is not installed.'
        : error.message;

      ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'agy' }));
      if (!completeSent && !agyProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'agy', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
      }
      notifyTerminalState({ error });

      settleOnce(() => reject(error));
    });

    agyProcess.stdin.end();
  });
}

function abortAgySession(sessionId) {
  const process = activeAgyProcesses.get(sessionId);
  if (process) {
    console.log(`Aborting Antigravity session: ${sessionId}`);
    process.aborted = true;
    process.kill('SIGTERM');
    // SIGTERM is not guaranteed to terminate a process blocked on a lock or
    // syscall; escalate to SIGKILL so a survivor cannot keep running invisibly
    // after cloudcli has forgotten about it.
    setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) {
        try {
          process.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, 5000);
    activeAgyProcesses.delete(sessionId);
    return true;
  }
  return false;
}

function isAgySessionActive(sessionId) {
  return activeAgyProcesses.has(sessionId);
}

function getActiveAgySessions() {
  return Array.from(activeAgyProcesses.keys());
}

export {
  spawnAgy,
  abortAgySession,
  isAgySessionActive,
  getActiveAgySessions,
};
