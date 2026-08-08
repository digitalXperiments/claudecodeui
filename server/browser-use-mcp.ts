#!/usr/bin/env node
import './load-env.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const textResponse = (text: string) => ({
  content: [{ type: 'text', text }],
});

const jsonResponse = (value: unknown) => textResponse(JSON.stringify(value, null, 2));

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const apiUrl = (process.env.CLOUDCLI_BROWSER_USE_API_URL || 'http://127.0.0.1:3001/api/browser-use-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_BROWSER_USE_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_API_TIMEOUT_MS || '60000', 10);

async function callBrowserUseApi(
  toolName: string,
  input: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_BROWSER_USE_MCP_TOKEN is not configured.');
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Browser API request failed (${response.status})`);
  }
  return data.data;
}

const sessionIdSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Browser session id.' },
  },
  required: ['sessionId'],
};

const tools: ToolDefinition[] = [
  {
    name: 'browser_create_session',
    description: 'Create a temporary Browser session that the agent can control. Optionally provide a background profileName to reuse cookies and storage.',
    inputSchema: {
      type: 'object',
      properties: {
        profileName: { type: 'string', description: 'Optional background profile name for persistent browser storage.' },
        recordNetwork: { type: 'boolean', description: 'Record bounded request/response traffic for network analysis (default true).' },
      },
    },
  },
  {
    name: 'browser_list_sessions',
    description: 'List Browser sessions currently available to agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture current page metadata, screenshot data URL, and visible body text for a Browser session.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_take_screenshot',
    description: 'Capture the latest screenshot for a Browser session.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a Browser session to an HTTP or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['sessionId', 'url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, visible text, or x/y coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused page or fill a CSS selector. Set submit to press Enter after typing.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields using CSS selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['sessionId', 'fields'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key, for example Enter, Escape, Tab, or Control+A.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['sessionId', 'key'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select option values in a select element found by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      },
      required: ['sessionId', 'selector', 'values'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for visible text, a URL pattern, or a short timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate JavaScript in the active page and return a bounded JSON serialization of the result.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        expression: { type: 'string', description: 'JavaScript expression or function body evaluated in the page.' },
        maxBytes: { type: 'number', description: 'Maximum serialized result size (default 100000 bytes).' },
      },
      required: ['sessionId', 'expression'],
    },
  },
  {
    name: 'browser_console_messages',
    description: 'Read buffered console logs and page errors for a session; optionally filter by level and clear the buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        level: { type: 'string', enum: ['debug', 'info', 'log', 'warn', 'error', 'pageerror'] },
        clear: { type: 'boolean', description: 'Clear the complete console buffer after reading.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_navigate_history',
    description: 'Navigate the active page back, forward, or reload it.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss the next alert, confirm, or prompt dialog. Set promptText when accepting a prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['accept', 'dismiss'] },
        promptText: { type: 'string' },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'browser_set_viewport',
    description: 'Set the active Browser viewport dimensions when supported by the driver.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['sessionId', 'width', 'height'],
    },
  },
  {
    name: 'browser_emulate_device',
    description: 'Emulate a common device preset using viewport, touch, user-agent, and Chromium CDP metrics when available.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        preset: { type: 'string', enum: ['desktop', 'iphone-13', 'pixel-7', 'ipad'] },
      },
      required: ['sessionId', 'preset'],
    },
  },
  {
    name: 'browser_download',
    description: 'Save a browser download triggered by a URL, selector click, or visible text into the session workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        fileName: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_upload_file',
    description: 'Upload a local file through an input element in the active page.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        filePath: { type: 'string', description: 'Path on the machine running CloudCLI.' },
      },
      required: ['sessionId', 'selector', 'filePath'],
    },
  },
  {
    name: 'browser_ask_human',
    description: 'Pause browser automation and wait for a human answer in the CloudCLI Browser panel.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        prompt: { type: 'string', description: 'Question or instruction shown to the human.' },
        choices: { type: 'array', items: { type: 'string' }, description: 'Optional suggested choices.' },
        secret: { type: 'boolean', description: 'Treat the answer as a secret; the result contains only a one-shot handle.' },
        timeoutMs: { type: 'number', description: 'Wait duration in milliseconds (default 5 minutes).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'browser_type_secret',
    description: 'Type a one-shot secret handle returned by browser_ask_human into a field without echoing the secret.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        secretHandle: { type: 'string' },
        selector: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['sessionId', 'secretHandle'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List, open, select, or close tabs in a Browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_network_requests',
    description: 'List captured network requests with URL, method, status, type, duration, and size filters.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string', description: 'Case-insensitive URL substring.' },
        urlRegex: { type: 'string', description: 'Regular expression matched against URLs.' },
        method: { type: 'string' },
        status: { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
        resourceType: { type: 'string' },
        minDurationMs: { type: 'number' },
        since: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        offset: { type: 'number' },
        limit: { type: 'number' },
        page: { type: 'number' },
        pageSize: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_network_get_request',
    description: 'Get one captured request with headers, timing, and bounded request/response bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        requestId: { type: 'string' },
        maxBodyBytes: { type: 'number' },
        includeSensitive: { type: 'boolean', description: 'Include Authorization/Cookie/Set-Cookie values.' },
        include_sensitive: { type: 'boolean', description: 'Alias for includeSensitive.' },
      },
      required: ['sessionId', 'requestId'],
    },
  },
  {
    name: 'browser_network_export_har',
    description: 'Export captured traffic as a HAR 1.2 file under the Browser session workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        fileName: { type: 'string', description: 'Optional output filename; it is kept inside the session workspace.' },
        includeSensitive: { type: 'boolean', description: 'Include Authorization/Cookie/Set-Cookie values.' },
        include_sensitive: { type: 'boolean', description: 'Alias for includeSensitive.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_network_analyze',
    description: 'Analyze the current capture or a supplied DevTools HAR for slow, failed, duplicate, and large requests.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        harPath: { type: 'string', description: 'Path to a HAR 1.2 file under the Browser session workspace root; omit to analyze the current session.' },
        url: { type: 'string' },
        urlRegex: { type: 'string' },
        method: { type: 'string' },
        status: { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
        resourceType: { type: 'string' },
        minDurationMs: { type: 'number' },
        since: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        topN: { type: 'number' },
        top_n: { type: 'number', description: 'Alias for topN.' },
      },
    },
  },
  {
    name: 'browser_network_clear',
    description: 'Clear the bounded network capture buffer for a Browser session.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_network_throttle',
    description: 'Apply a CDP network preset to the Browser session: offline, slow-3g, fast-3g, or none.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        preset: { type: 'string', enum: ['offline', 'slow-3g', 'fast-3g', 'none'] },
      },
      required: ['sessionId', 'preset'],
    },
  },
  {
    name: 'browser_close_session',
    description: 'Stop a Browser session controlled by agents.',
    inputSchema: sessionIdSchema,
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'browser_create_session':
      return jsonResponse(await callBrowserUseApi(name, {
        profileName: readOptionalString(args.profileName),
        recordNetwork: typeof args.recordNetwork === 'boolean' ? args.recordNetwork : undefined,
      }));
    case 'browser_list_sessions':
      return jsonResponse(await callBrowserUseApi(name, {}));
    case 'browser_snapshot':
      return jsonResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    case 'browser_take_screenshot': {
      return jsonResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    }
    case 'browser_navigate':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        url: readString(args.url, 'url'),
      }));
    case 'browser_click':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        text: readOptionalString(args.text),
        x: readNumber(args.x),
        y: readNumber(args.y),
      }));
    case 'browser_type':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        text: readString(args.text, 'text'),
        submit: args.submit === true,
      }));
    case 'browser_fill_form': {
      const fields = Array.isArray(args.fields)
        ? args.fields.map((field) => {
          const record = field as Record<string, unknown>;
          return {
            selector: readString(record.selector, 'field.selector'),
            value: readString(record.value, 'field.value'),
          };
        })
        : [];
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        fields,
      }));
    }
    case 'browser_press_key':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        key: readString(args.key, 'key'),
      }));
    case 'browser_select_option':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readString(args.selector, 'selector'),
        values: Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : [],
      }));
    case 'browser_wait_for':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        text: readOptionalString(args.text),
        url: readOptionalString(args.url),
        timeoutMs: readNumber(args.timeoutMs),
      }));
    case 'browser_evaluate':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        expression: readString(args.expression, 'expression'),
        maxBytes: readNumber(args.maxBytes),
      }));
    case 'browser_console_messages':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        level: readOptionalString(args.level),
        clear: args.clear === true,
      }));
    case 'browser_navigate_history': {
      const action = args.action === 'back' || args.action === 'forward' || args.action === 'reload'
        ? args.action
        : (() => { throw new Error('action must be back, forward, or reload.'); })();
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        action,
      }));
    }
    case 'browser_handle_dialog': {
      const action = args.action === 'accept' || args.action === 'dismiss'
        ? args.action
        : (() => { throw new Error('action must be accept or dismiss.'); })();
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        action,
        promptText: readOptionalString(args.promptText),
      }));
    }
    case 'browser_set_viewport':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        width: readNumber(args.width) ?? (() => { throw new Error('width is required.'); })(),
        height: readNumber(args.height) ?? (() => { throw new Error('height is required.'); })(),
      }));
    case 'browser_emulate_device': {
      const preset = args.preset === 'desktop' || args.preset === 'iphone-13'
        || args.preset === 'pixel-7' || args.preset === 'ipad'
        ? args.preset
        : (() => { throw new Error('preset must be desktop, iphone-13, pixel-7, or ipad.'); })();
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        preset,
      }));
    }
    case 'browser_download':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        url: readOptionalString(args.url),
        selector: readOptionalString(args.selector),
        text: readOptionalString(args.text),
        fileName: readOptionalString(args.fileName),
        timeoutMs: readNumber(args.timeoutMs),
      }));
    case 'browser_upload_file':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readString(args.selector, 'selector'),
        filePath: readString(args.filePath, 'filePath'),
      }));
    case 'browser_ask_human': {
      const timeoutMs = readNumber(args.timeoutMs);
      const apiTimeoutMs = Math.max(
        API_TIMEOUT_MS,
        Math.min((timeoutMs ?? 5 * 60 * 1000) + 10_000, 30 * 60 * 1000 + 10_000),
      );
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readOptionalString(args.sessionId),
        prompt: readString(args.prompt, 'prompt'),
        choices: Array.isArray(args.choices)
          ? args.choices.filter((choice): choice is string => typeof choice === 'string')
          : undefined,
        secret: args.secret === true,
        timeoutMs,
      }, { timeoutMs: apiTimeoutMs }));
    }
    case 'browser_type_secret':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        secretHandle: readString(args.secretHandle, 'secretHandle'),
        selector: readOptionalString(args.selector),
        submit: args.submit === true,
      }));
    case 'browser_tabs':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        action: args.action === 'new' || args.action === 'select' || args.action === 'close' || args.action === 'list'
          ? args.action
          : undefined,
        index: readNumber(args.index),
        url: readOptionalString(args.url),
      }));
    case 'browser_network_requests':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        url: readOptionalString(args.url),
        urlRegex: readOptionalString(args.urlRegex),
        method: readOptionalString(args.method),
        status: typeof args.status === 'number'
          ? readNumber(args.status)
          : Array.isArray(args.status)
            ? args.status.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
            : undefined,
        resourceType: readOptionalString(args.resourceType),
        minDurationMs: readNumber(args.minDurationMs),
        since: typeof args.since === 'string' ? readOptionalString(args.since) : readNumber(args.since),
        offset: readNumber(args.offset),
        limit: readNumber(args.limit),
        page: readNumber(args.page),
        pageSize: readNumber(args.pageSize),
      }));
    case 'browser_network_get_request':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        requestId: readString(args.requestId, 'requestId'),
        maxBodyBytes: readNumber(args.maxBodyBytes),
        includeSensitive: args.includeSensitive === true || args.include_sensitive === true,
      }));
    case 'browser_network_export_har':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        fileName: readOptionalString(args.fileName),
        includeSensitive: args.includeSensitive === true || args.include_sensitive === true,
      }));
    case 'browser_network_analyze':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readOptionalString(args.sessionId),
        harPath: readOptionalString(args.harPath),
        url: readOptionalString(args.url),
        urlRegex: readOptionalString(args.urlRegex),
        method: readOptionalString(args.method),
        status: typeof args.status === 'number'
          ? readNumber(args.status)
          : Array.isArray(args.status)
            ? args.status.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
            : undefined,
        resourceType: readOptionalString(args.resourceType),
        minDurationMs: readNumber(args.minDurationMs),
        since: typeof args.since === 'string' ? readOptionalString(args.since) : readNumber(args.since),
        topN: readNumber(args.topN ?? args.top_n),
      }));
    case 'browser_network_clear':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
      }));
    case 'browser_network_throttle':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        preset: args.preset === 'offline' || args.preset === 'slow-3g' || args.preset === 'fast-3g' || args.preset === 'none'
          ? args.preset
          : (() => { throw new Error('preset must be offline, slow-3g, fast-3g, or none.'); })(),
      }));
    case 'browser_close_session':
      return jsonResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-browser', version: '1.0.0' },
    };
  }

  if (message.method === 'tools/list') {
    return { tools };
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = readString(params.name, 'name');
    const args = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments
      : {}) as Record<string, unknown>;
    return callTool(name, args);
  }

  if (message.method.startsWith('notifications/')) {
    return undefined;
  }

  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport uses newline-delimited JSON (one JSON-RPC message per line,
  // no embedded newlines). This is NOT the LSP Content-Length framing.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: string | number | null | undefined, result: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null | undefined, error: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) {
      continue;
    }

    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(rawMessage) as JsonRpcRequest;
      } catch (error) {
        sendError(null, error);
        return;
      }
      try {
        const result = await handleMessage(request);
        sendResult(request.id, result);
      } catch (error) {
        sendError(request.id, error);
      }
    })();
  }
});
