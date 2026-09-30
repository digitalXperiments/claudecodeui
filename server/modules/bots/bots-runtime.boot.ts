/**
 * Boot wiring for the bot runtime (v2). Everything here is inert while the
 * `feature.bots_runtime_v2` flag is off; flipping the flag starts or stops the runtime
 * without a server restart.
 */
import { isBotsRuntimeV2Enabled, onAppFeaturesChanged } from '@/modules/app-features/index.js';

import { actionGate, initBotGate } from './gate/index.js';
import { registerBotGatewayMcp, setGatewayGate, unregisterBotGatewayMcp } from './gateway/index.js';
import { installKernel } from './kernel/install.js';
import { botSignals, startSignals, stopSignals } from './signals/index.js';

type WakeHandler = (botId: string) => void;

let running = false;
let coreReady = false;
let wakeHandler: WakeHandler | null = null;

/** The kernel registers itself here; until then woken bots simply keep their queued events. */
export function setBotsRuntimeWakeHandler(handler: WakeHandler | null): void {
  wakeHandler = handler;
  if (running) botSignals.setWakeHandler(handler);
}

type RuntimeHook = { start: () => void | Promise<void>; stop: () => void | Promise<void> };
const hooks: RuntimeHook[] = [];

/** Later waves (kernel, channels, learning) plug their lifecycle in here. */
export function registerBotsRuntimeHook(hook: RuntimeHook): void {
  hooks.push(hook);
  if (running) void Promise.resolve(hook.start()).catch((error) => console.error('[bots] runtime hook start failed:', error));
}

function initCore(): void {
  if (coreReady) return;
  coreReady = true;
  // The gate's interrupt resolver and the gateway's gate are safe to wire regardless of the
  // flag: with the flag off no run is bound to the gateway, so neither is ever consulted.
  initBotGate();
  setGatewayGate({
    evaluate: (ctx, req) => actionGate.evaluate(ctx, req),
    awaitHuman: (decisionId, options) => actionGate.awaitHuman(decisionId, options),
    // The gateway reports a structured call result; the audit log stores executed|error.
    recordOutcome: (decisionId, outcome) => actionGate.recordOutcome(decisionId, outcome.ok ? 'executed' : 'error'),
  });
}

export async function startBotsRuntime(): Promise<void> {
  initCore();
  if (running || !isBotsRuntimeV2Enabled()) return;
  running = true;
  botSignals.setWakeHandler(wakeHandler);
  startSignals();
  await registerBotGatewayMcp().catch((error: unknown) => {
    console.error('[bots] failed to register cloudcli-tool-gateway MCP:', error);
  });
  for (const hook of hooks) {
    await Promise.resolve(hook.start()).catch((error) => console.error('[bots] runtime hook start failed:', error));
  }
  console.log('[bots] runtime v2 started');
}

export async function stopBotsRuntime(options: { unregisterGateway?: boolean } = {}): Promise<void> {
  if (!running) return;
  running = false;
  for (const hook of [...hooks].reverse()) {
    await Promise.resolve(hook.stop()).catch((error) => console.error('[bots] runtime hook stop failed:', error));
  }
  stopSignals();
  botSignals.setWakeHandler(null);
  // Turning the flag off leaves no stale gateway entry in provider configs. A plain server
  // shutdown keeps it, so restarts don't rewrite ~/.claude.json and friends each time.
  if (options.unregisterGateway) {
    await Promise.resolve(unregisterBotGatewayMcp()).catch((error: unknown) => {
      console.error('[bots] failed to unregister cloudcli-tool-gateway MCP:', error);
    });
  }
  console.log('[bots] runtime v2 stopped');
}

export function isBotsRuntimeRunning(): boolean {
  return running;
}

let flagListenerInstalled = false;

/** Boot entry: start if the flag is on and follow later flag flips. */
export async function bootBotsRuntime(): Promise<void> {
  initCore();
  installKernel();
  if (!flagListenerInstalled) {
    flagListenerInstalled = true;
    onAppFeaturesChanged((next, previous) => {
      if (next.botsRuntimeV2 === previous.botsRuntimeV2) return;
      void (next.botsRuntimeV2 ? startBotsRuntime() : stopBotsRuntime({ unregisterGateway: true }));
    });
  }
  await startBotsRuntime();
}
