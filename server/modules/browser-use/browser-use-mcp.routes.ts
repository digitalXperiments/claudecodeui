import express from 'express';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

router.use((req, res, next) => {
  const expected = browserUseService.getMcpToken();
  const token = readBearerToken(req.headers.authorization) || String(req.headers['x-browser-use-mcp-token'] || '');
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid Browser MCP token.' });
    return;
  }
  next();
});

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const toolName = req.params.toolName;
    let result: unknown;

    switch (toolName) {
      case 'browser_create_session':
        result = await browserUseService.createAgentSession({
          profileName: typeof input.profileName === 'string' ? input.profileName : null,
          recordNetwork: typeof input.recordNetwork === 'boolean' ? input.recordNetwork : undefined,
        });
        break;
      case 'browser_list_sessions':
        result = await browserUseService.listAgentSessions();
        break;
      case 'browser_snapshot':
      case 'browser_take_screenshot':
        result = await browserUseService.agentSnapshot(sessionId);
        break;
      case 'browser_navigate':
        result = await browserUseService.agentNavigate(sessionId, String(input.url || ''));
        break;
      case 'browser_click':
        result = await browserUseService.agentClick(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: typeof input.text === 'string' ? input.text : undefined,
          x: typeof input.x === 'number' ? input.x : undefined,
          y: typeof input.y === 'number' ? input.y : undefined,
        });
        break;
      case 'browser_type':
        result = await browserUseService.agentType(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: String(input.text || ''),
          submit: input.submit === true,
        });
        break;
      case 'browser_fill_form':
        result = await browserUseService.agentFillForm(
          sessionId,
          Array.isArray(input.fields)
            ? input.fields.map((field) => {
              const record = field as Record<string, unknown>;
              return {
                selector: String(record.selector || ''),
                value: String(record.value || ''),
              };
            })
            : [],
        );
        break;
      case 'browser_press_key':
        result = await browserUseService.agentPressKey(sessionId, String(input.key || ''));
        break;
      case 'browser_select_option':
        result = await browserUseService.agentSelectOption(
          sessionId,
          String(input.selector || ''),
          Array.isArray(input.values) ? input.values.filter((value): value is string => typeof value === 'string') : [],
        );
        break;
      case 'browser_wait_for':
        result = await browserUseService.agentWaitFor(sessionId, {
          text: typeof input.text === 'string' ? input.text : undefined,
          url: typeof input.url === 'string' ? input.url : undefined,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
        });
        break;
      case 'browser_evaluate':
        result = await browserUseService.agentEvaluate(sessionId, {
          expression: typeof input.expression === 'string' ? input.expression : '',
          maxBytes: typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
        });
        break;
      case 'browser_console_messages': {
        const rawLevel = typeof input.level === 'string' ? input.level.toLowerCase() : undefined;
        const level = rawLevel === 'debug' || rawLevel === 'info' || rawLevel === 'log'
          || rawLevel === 'warn' || rawLevel === 'warning' || rawLevel === 'error' || rawLevel === 'pageerror'
          ? rawLevel === 'warning' ? 'warn' : rawLevel
          : undefined;
        result = await browserUseService.agentConsoleMessages(sessionId, {
          level,
          clear: input.clear === true,
        });
        break;
      }
      case 'browser_navigate_history':
        if (input.action !== 'back' && input.action !== 'forward' && input.action !== 'reload') {
          throw new Error('action must be back, forward, or reload.');
        }
        result = await browserUseService.agentNavigateHistory(sessionId, input.action);
        break;
      case 'browser_handle_dialog':
        if (input.action !== 'accept' && input.action !== 'dismiss') {
          throw new Error('action must be accept or dismiss.');
        }
        result = await browserUseService.agentHandleDialog(sessionId, {
          action: input.action,
          promptText: typeof input.promptText === 'string' ? input.promptText : undefined,
        });
        break;
      case 'browser_set_viewport':
        result = await browserUseService.agentSetViewport(sessionId, {
          width: typeof input.width === 'number' ? input.width : 0,
          height: typeof input.height === 'number' ? input.height : 0,
        });
        break;
      case 'browser_emulate_device':
        if (input.preset !== 'desktop' && input.preset !== 'iphone-13'
          && input.preset !== 'pixel-7' && input.preset !== 'ipad') {
          throw new Error('preset must be desktop, iphone-13, pixel-7, or ipad.');
        }
        result = await browserUseService.agentEmulateDevice(sessionId, input.preset);
        break;
      case 'browser_download':
        result = await browserUseService.agentDownload(sessionId, {
          url: typeof input.url === 'string' ? input.url : undefined,
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: typeof input.text === 'string' ? input.text : undefined,
          fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
        });
        break;
      case 'browser_upload_file':
        result = await browserUseService.agentUploadFile(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : '',
          filePath: typeof input.filePath === 'string' ? input.filePath : '',
        });
        break;
      case 'browser_type_secret':
        result = await browserUseService.agentTypeSecret(sessionId, {
          secretHandle: typeof input.secretHandle === 'string' ? input.secretHandle : '',
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          submit: input.submit === true,
        });
        break;
      case 'browser_ask_human':
        result = await browserUseService.agentAskHuman({
          sessionId: sessionId || null,
          prompt: typeof input.prompt === 'string' ? input.prompt : typeof input.question === 'string' ? input.question : '',
          choices: Array.isArray(input.choices)
            ? input.choices.filter((choice): choice is string => typeof choice === 'string')
            : undefined,
          secret: input.secret === true,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
        });
        break;
      case 'browser_tabs':
        result = await browserUseService.agentTabs(sessionId, {
          action: input.action === 'new' || input.action === 'select' || input.action === 'close' || input.action === 'list'
            ? input.action
            : undefined,
          index: typeof input.index === 'number' ? input.index : undefined,
          url: typeof input.url === 'string' ? input.url : undefined,
        });
        break;
      case 'browser_network_requests':
        result = await browserUseService.agentNetworkRequests(sessionId, input);
        break;
      case 'browser_network_get_request':
        result = await browserUseService.agentNetworkGetRequest(sessionId, String(input.requestId || input.id || ''), {
          includeSensitive: input.includeSensitive === true || input.include_sensitive === true,
          maxBodyBytes: typeof input.maxBodyBytes === 'number' ? input.maxBodyBytes : undefined,
        });
        break;
      case 'browser_network_export_har':
        result = await browserUseService.agentNetworkExportHar(sessionId, input);
        break;
      case 'browser_network_analyze':
        result = await browserUseService.agentNetworkAnalyze(sessionId || undefined, input);
        break;
      case 'browser_network_clear':
        result = await browserUseService.agentNetworkClear(sessionId);
        break;
      case 'browser_network_throttle': {
        if (input.preset !== 'offline' && input.preset !== 'slow-3g'
          && input.preset !== 'fast-3g' && input.preset !== 'none') {
          throw new Error('preset must be offline, slow-3g, fast-3g, or none.');
        }
        const preset = input.preset;
        result = await browserUseService.agentNetworkThrottle(sessionId, preset);
        break;
      }
      case 'browser_close_session':
        result = await browserUseService.agentStopSession(sessionId);
        break;
      default:
        res.status(404).json({ success: false, error: `Unknown Browser MCP tool "${toolName}".` });
        return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Browser MCP tool failed.',
    });
  }
});

export default router;
