export const CLICKABLE_PROTOTYPE_SKILL = `---
name: clickable-prototype
description: Build a self-contained, clickable HTML prototype (Claude Design style). Use when the user wants a visual mock, landing page, dashboard, or multi-screen walkthrough they can click through in a preview iframe.
---

# Clickable prototype

Write one file: \`prototype.html\`. It must be self-contained (inline CSS + JS). No build step. No external frameworks unless a CDN is explicitly requested.

## Rules

- Multi-screen apps use in-page navigation (\`data-screen\`, buttons, hash). Do not use real routes that leave the file.
- Every primary action must do something visible (screen change, modal, toast, state toggle).
- Use real-looking copy and layout, not lorem and gray boxes, unless the brief asks for wireframes.
- Respect any existing design tokens in \`notes.md\` or the project UI.
- Keep the file under ~200KB unless the brief needs more.
- Prefer system fonts or a single Google Fonts import.
- Mobile: a useful layout at 390px wide. Desktop: 1280px.

## Output contract

1. Update \`prototype.html\` in the prototype directory.
2. Update \`notes.md\` with IA, tokens, and open questions.
3. Update \`handoff.md\` with what an implementer should build in the real app.

Do not rewrite the host CloudCLI application. Only touch files under the prototype directory.

Edits to \`prototype.html\`, \`notes.md\`, and \`handoff.md\` are the required source changes for this job. A no-op is a failure.
`;
