# CloudCLI Browser MCP

The `cloudcli-browser` MCP server is a stdio server backed by the local CloudCLI
browser route. Browser sessions and prompt answers stay in the server process;
the session workspace is used only for bounded HAR exports and downloads.

## Human input

The server uses the existing authenticated `/api/browser-use` route as its
human-input bridge. The Browser panel polls `/prompts`, renders the question,
and posts the answer to `/prompts/:promptId/answer`; a system notification is
also created so a pending prompt is visible in the CloudCLI notification inbox.
This is the best available mechanism in this server because the current MCP
stdio façade does not use an SDK transport with `server.elicitInput` support.
Prompt answers are accepted only through the authenticated Browser panel/API
route; MCP clients cannot inspect or answer their own pending prompts.

Secret prompts are never returned as values. `browser_ask_human` returns a
one-shot `secretHandle`, and `browser_type_secret` consumes that handle in
memory. Handles expire automatically and are not persisted; the secret typing
result also omits the post-entry screenshot.

## Tools

Session and page control:

- `browser_create_session`, `browser_close_session`, `browser_list_sessions`
- `browser_navigate`, `browser_navigate_history`
- `browser_click`, `browser_type`, `browser_type_secret`, `browser_fill_form`
- `browser_press_key`, `browser_select_option`, `browser_wait_for`
- `browser_snapshot`, `browser_take_screenshot`, `browser_tabs`
- `browser_evaluate`, `browser_console_messages`
- `browser_handle_dialog`, `browser_set_viewport`, `browser_emulate_device`
- `browser_download`, `browser_upload_file`

Human input:

- `browser_ask_human` (answered by the authenticated Browser panel)

Network and HAR analysis:

- `browser_network_requests`, `browser_network_get_request`
- `browser_network_export_har`, `browser_network_analyze`
- `browser_network_clear`, `browser_network_throttle`

Network capture remains bounded per session. Sensitive headers are redacted by
default and request/response bodies are capped; opt in to sensitive headers
only when the diagnostic requires them.

No requested browser tool is deliberately skipped: download and upload use the
existing Playwright session workspace and file-input plumbing.
