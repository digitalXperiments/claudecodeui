import { resolveBotHome } from '../bots-home.js';
import { createBuiltinToolGate, type BuiltinToolGate } from '../gate/builtin-tool-gate.js';

import { isSessionTainted } from './gateway.service.js';
import { gatewaySessions } from './sessions.js';

export interface GatewayRunGuards {
  /** Install as `options.builtinToolGate` (claude-sdk turns it into canUseTool for gateway-bound runs). */
  builtinToolGate: BuiltinToolGate;
  /** Install as `options.botGatewaySecret`; undefined when the session is not bound. */
  bindingSecret: string | undefined;
}

/**
 * The per-run guards a gateway-bound Claude run needs besides the gateway itself. Call AFTER
 * `gatewaySessions.bind(appSessionId, ...)` so the binding secret exists, then:
 *
 *   const guards = buildGatewayRunGuards(section, { appSessionId, episodeId, runId, projectPath });
 *   options.builtinToolGate = guards.builtinToolGate;
 *   options.botGatewaySecret = guards.bindingSecret;
 */
export function buildGatewayRunGuards(
  section: { section_id: string },
  run: { appSessionId: string; episodeId?: string; runId?: string; projectPath: string },
): GatewayRunGuards {
  const builtinToolGate = createBuiltinToolGate({
    botId: section.section_id,
    episodeId: run.episodeId,
    runId: run.runId,
    workspaceRoot: run.projectPath,
    botHome: resolveBotHome(section.section_id),
    tainted: () => isSessionTainted(run.appSessionId),
    isBound: () => gatewaySessions.get(run.appSessionId) !== null,
  });
  return { builtinToolGate, bindingSecret: gatewaySessions.get(run.appSessionId)?.secret };
}
