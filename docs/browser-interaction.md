# Browser interaction

Browser sessions are agent-owned by default. The Browser panel can temporarily acquire human control for a ready session. While `controller` is `human`, every agent browser mutation is rejected with a clear ownership error; returning control resumes agent actions.

The authenticated `POST /api/browser-use/sessions/:sessionId/control` endpoint accepts:

- `{ "action": "take" }` or `{ "action": "return" }` to transition ownership.
- `{ "action": "click", "x": number, "y": number }` using browser viewport coordinates.
- `{ "action": "key", "key": string }`, `{ "action": "type", "text": string }`, and `{ "action": "scroll", "deltaX": number, "deltaY": number }`.
- `{ "action": "navigate", "url": string }` for bounded HTTP(S) navigation.

The panel translates clicks from the displayed screenshot into viewport coordinates, accounting for aspect-ratio letterboxing. It focuses the viewer only while takeover is active and prevents browser-panel hotkeys from handling forwarded keystrokes. Input text is never logged or stored as an action; screenshots are suppressed after typing so typed values are not persisted in session state. Existing human prompts and secret handles remain separate and continue to use their prompt endpoints.
