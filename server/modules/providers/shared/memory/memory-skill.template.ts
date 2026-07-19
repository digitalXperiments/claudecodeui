/**
 * Canonical "Memory" project skill.
 *
 * Authored once and fanned out to every agent's project skill directory when a
 * project enables memory. It encodes the hybrid read/write contract for the
 * Obsidian second brain: read context at the start of work, append a session
 * note at the end, and promote durable facts into Decisions/Entities as they
 * arise. The agent reaches the vault through the `obsidian` MCP server that is
 * installed alongside this skill.
 */
export const MEMORY_SKILL_DIRECTORY_NAME = 'project-memory';

export const buildMemorySkillContent = (vaultFolder: string): string => `---
name: project-memory
description: Read and write this project's Obsidian second brain. Use at the start of every task to load prior context, and at the end to record what happened. Any agent working in this project should follow this.
---

# Project Memory (Obsidian second brain)

This project has a persistent memory stored in an Obsidian vault folder:
\`${vaultFolder}\`. Access it through the \`obsidian\` MCP tools
(\`search_notes\`, \`get_note\`, \`get_backlinks\`, \`create_note\`,
\`update_note\`, \`list_notes\`). Always scope note paths under
\`${vaultFolder}/\`.

The goal is a compounding wiki: every agent, in every session, inherits the
context left by previous ones. Treat memory as shared team knowledge, not a
scratchpad.

## Folder layout

- \`${vaultFolder}/00-Overview.md\` — canonical project summary: goals, constraints, stack. The home note.
- \`${vaultFolder}/Index.md\` — map of content (MOC); links out to everything.
- \`${vaultFolder}/Decisions/\` — one note per architectural/product decision (ADR-style).
- \`${vaultFolder}/Entities/\` — services, endpoints, people, glossary terms — the wiki nodes.
- \`${vaultFolder}/Sessions/\` — append-only dated logs, one note per day per agent.

## At the START of a task (always)

1. \`get_note\` \`${vaultFolder}/00-Overview.md\` to load the project frame.
2. \`search_notes\` for terms relevant to your task; skim the top hits.
3. For any note central to your task, \`get_backlinks\` to find related context.

Do this before writing code or making decisions. Prior context prevents
re-litigating settled questions.

## DURING a task (promote as you go)

- When a real decision is made, create \`${vaultFolder}/Decisions/<slug>.md\`
  (what, why, alternatives, date) and \`[[link]]\` it from \`Index.md\` and any
  relevant note.
- When you discover a durable fact about a service/endpoint/person/term, create
  or update the matching note in \`${vaultFolder}/Entities/\`.
- Use \`[[wiki links]]\` liberally so the graph stays connected.

## At the END of a task (always)

Append a short structured entry to today's session note
\`${vaultFolder}/Sessions/YYYY-MM-DD-<agent>.md\` using \`update_note\` with
\`append: true\` (create it if missing):

\`\`\`
## <HH:MM> — <one-line summary>
- **Did:** what changed / what you produced
- **Why:** the reason, if not obvious
- **Decisions:** [[links to any Decisions notes created]]
- **Open:** anything left unresolved for the next agent
\`\`\`

Keep entries terse and factual. If nothing durable happened, a single line is
fine — but always leave a trace so the timeline stays continuous.

## Conventions

- Note names: kebab-case for Decisions/Entities (e.g. \`auth-token-rotation\`).
- Never delete another agent's notes; correct by adding, not erasing.
- Prefer linking to duplicating: if a fact exists, link it.
`;
