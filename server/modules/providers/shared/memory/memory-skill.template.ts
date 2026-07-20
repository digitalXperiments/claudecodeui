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
\`${vaultFolder}\`. Access it through the \`obsidian\` MCP server and always
scope note paths under \`${vaultFolder}/\`.

The goal is a compounding wiki: every agent, in every session, inherits the
context left by previous ones. Treat memory as shared team knowledge, not a
scratchpad.

## Obsidian MCP tools — exact names & arguments

Use these **exact** tool names and argument names. Do not guess or invent them
(there is no get_note, create_note, search_notes, or get_backlinks tool). The
\`filename\` argument is **required** and must be the **full vault path including
the \`.md\` extension**, e.g. \`${vaultFolder}/00-Overview.md\`.

| Purpose | Tool | Required args | Notes |
| --- | --- | --- | --- |
| Read a note | \`obsidian_get_file\` | \`filename\` (string) | Full path incl. \`.md\`. |
| Full-text search | \`obsidian_simple_search\` | \`query\` (string) | Optional \`contextLength\` (number). |
| List a folder | \`obsidian_list_vault_directory\` | \`pathToDirectory\` (string) | Use \`obsidian_list_vault_root\` (no args) for the vault root. |
| Create / overwrite a note | \`obsidian_put_file\` | \`filename\`, \`content\` (strings) | Replaces the whole file. |
| Append to a note (creates if missing) | \`obsidian_post_file\` | \`filename\`, \`content\` (strings) | Use this for Session logs. |
| Insert at a heading / block | \`obsidian_patch_file\` | \`filename\`, \`operation\`, \`targetType\`, \`target\`, \`content\` | \`operation\`: \`append\`/\`prepend\`/\`replace\`; \`targetType\`: \`heading\`/\`block\`/\`frontmatter\`. |
| Check vault is reachable | \`obsidian_status\` | (none) | |

There is **no dedicated backlinks tool** — find references to a note by running
\`obsidian_simple_search\` for \`[[note-name]]\`.

> If these tools are not available, the \`obsidian\` MCP server is not connected —
> tell the user and continue without memory rather than guessing.

## Folder layout

- \`${vaultFolder}/00-Overview.md\` — canonical project summary: goals, constraints, stack. The home note.
- \`${vaultFolder}/Index.md\` — map of content (MOC); links out to everything.
- \`${vaultFolder}/Decisions/\` — one note per architectural/product decision (ADR-style).
- \`${vaultFolder}/Entities/\` — services, endpoints, people, glossary terms — the wiki nodes.
- \`${vaultFolder}/Sessions/\` — append-only dated logs, one note per day per agent.

## At the START of a task (always)

1. \`obsidian_get_file\` \`{ "filename": "${vaultFolder}/00-Overview.md" }\` to load the project frame.
2. \`obsidian_simple_search\` \`{ "query": "<terms relevant to your task>" }\`; read the top hits with \`obsidian_get_file\`.
3. For any note central to your task, \`obsidian_simple_search\` \`[[note-name]]\` to find related context (backlinks).

Do this before writing code or making decisions. Prior context prevents
re-litigating settled questions.

## DURING a task (promote as you go)

- When a real decision is made, create \`${vaultFolder}/Decisions/<slug>.md\`
  with \`obsidian_put_file\` (what, why, alternatives, date) and \`[[link]]\` it
  from \`Index.md\` and any relevant note.
- When you discover a durable fact about a service/endpoint/person/term, create
  or update the matching note in \`${vaultFolder}/Entities/\` with
  \`obsidian_put_file\` (overwrite) or \`obsidian_patch_file\` (insert).
- Use \`[[wiki links]]\` liberally so the graph stays connected.

## At the END of a task (always)

Append a short structured entry to today's session note
\`${vaultFolder}/Sessions/YYYY-MM-DD-<agent>.md\` using \`obsidian_post_file\`
(it creates the file if missing):

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
