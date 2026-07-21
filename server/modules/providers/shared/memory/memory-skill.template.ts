/**
 * Canonical "Memory" skill template.
 *
 * The template is seeded into the managed global skills store
 * (`~/.cloudcli/skills/project-memory/SKILL.md`) where users can edit the
 * contract from the Global Skills settings tab. When a project enables memory,
 * the active template is rendered with that project's vault folder and fanned
 * out to every agent's project skill directory. It encodes the hybrid
 * read/write contract for the Obsidian second brain: read context at the start
 * of work, append a session note at the end, and promote durable facts into
 * Decisions/Entities as they arise. The agent reaches the vault through the
 * `obsidian` MCP server that is installed alongside this skill.
 */
export const MEMORY_SKILL_DIRECTORY_NAME = 'project-memory';

/**
 * Token replaced with the project's vault-relative folder when the template is
 * rendered for one project.
 */
export const MEMORY_SKILL_VAULT_FOLDER_TOKEN = '{{vaultFolder}}';

export const MEMORY_SKILL_TEMPLATE = `---
name: project-memory
description: Read and write this project's Obsidian second brain. Use at the start of every task to load prior context, and at the end to record what happened. Any agent working in this project should follow this.
---

# Project Memory (Obsidian second brain)

This project has a persistent memory stored in an Obsidian vault folder:
\`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}\`. Access it through the \`obsidian\` MCP server and always
scope note paths under \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/\`.

The goal is a compounding wiki: every agent, in every session, inherits the
context left by previous ones. Treat memory as shared team knowledge, not a
scratchpad.

## Obsidian MCP tools — exact names & arguments

Use these **exact** tool names and argument names. Do not guess or invent them
(there is no get_note, create_note, search_notes, or get_backlinks tool). The
\`filename\` argument is **required** and must be the **full vault path including
the \`.md\` extension**, e.g. \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/00-Overview.md\`.

**Read tools** — return JSON and behave normally:

| Purpose | Tool | Required args | Notes |
| --- | --- | --- | --- |
| Read a note | \`obsidian_get_file\` | \`filename\` (string) | Full path incl. \`.md\`. |
| Full-text search | \`obsidian_simple_search\` | \`query\` (string) | Optional \`contextLength\` (number). |
| List a folder | \`obsidian_list_vault_directory\` | \`pathToDirectory\` (string) | Use \`obsidian_list_vault_root\` (no args) for the vault root. |
| Check vault is reachable | \`obsidian_status\` | (none) | |

**Write tools** — mutate the vault. Read the success-looks-like-an-error rule below before using them:

| Purpose | Tool | Required args | Notes |
| --- | --- | --- | --- |
| Create / overwrite a note | \`obsidian_put_file\` | \`filename\`, \`content\` (strings) | Replaces the whole file. |
| Append to a note (creates if missing) | \`obsidian_post_file\` | \`filename\`, \`content\` (strings) | Use this for Session logs. |
| Insert at a heading / block | \`obsidian_patch_file\` | \`filename\`, \`operation\`, \`targetType\`, \`target\`, \`content\` | \`operation\`: \`append\`/\`prepend\`/\`replace\`; \`targetType\`: \`heading\`/\`block\`/\`frontmatter\`. |

### ⚠️ Writes report a false error — treat \`Unexpected end of JSON input\` as SUCCESS

Every mutating tool (\`obsidian_put_file\`, \`obsidian_post_file\`,
\`obsidian_patch_file\`, and any delete) returns the error
**\`Unexpected end of JSON input\`** *even when the write succeeded*. This is a
known client quirk, **not** a real failure: the Local REST API replies
\`204 No Content\` with an empty body, and the MCP client errors parsing the empty
response — the note was still written to disk.

When you see \`Unexpected end of JSON input\` from a write tool:

1. **Treat it as success.** The write already happened.
2. **Do NOT retry** the call, and **do NOT switch to another write tool** —
   retrying re-writes the same content (or, with \`obsidian_post_file\`, appends a
   duplicate).
3. If you must be certain, **read the note back once** with \`obsidian_get_file\`
   and confirm your content is present. That is the only reliable success check.
4. Only treat it as a *real* failure if that read-back shows the content is
   missing, or if you get a **different** error (connection refused, a 404 on the
   parent folder, a 4xx/5xx status). Those are genuine — surface them.

Never tell the user "memory failed" or skip the session log because of this
error alone: the write worked.

There is **no dedicated backlinks tool** — find references to a note by running
\`obsidian_simple_search\` for \`[[note-name]]\`.

> If these tools are not available — meaning \`obsidian_status\` itself fails with a
> **connection** error (not the false \`Unexpected end of JSON input\` above) — the
> \`obsidian\` MCP server is not connected. Tell the user and continue without
> memory rather than guessing.

## Folder layout

- \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/00-Overview.md\` — canonical project summary: goals, constraints, stack. The home note.
- \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Index.md\` — map of content (MOC); links out to everything.
- \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Decisions/\` — one note per architectural/product decision (ADR-style).
- \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Entities/\` — services, endpoints, people, glossary terms — the wiki nodes.
- \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Sessions/\` — append-only dated logs, one note per day per agent.

## At the START of a task (always)

1. \`obsidian_get_file\` \`{ "filename": "${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/00-Overview.md" }\` to load the project frame.
2. \`obsidian_simple_search\` \`{ "query": "<terms relevant to your task>" }\`; read the top hits with \`obsidian_get_file\`.
3. For any note central to your task, \`obsidian_simple_search\` \`[[note-name]]\` to find related context (backlinks).

Do this before writing code or making decisions. Prior context prevents
re-litigating settled questions.

## DURING a task (promote as you go)

- When a real decision is made, create \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Decisions/<slug>.md\`
  with \`obsidian_put_file\` (what, why, alternatives, date) and \`[[link]]\` it
  from \`Index.md\` and any relevant note.
- When you discover a durable fact about a service/endpoint/person/term, create
  or update the matching note in \`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Entities/\` with
  \`obsidian_put_file\` (overwrite) or \`obsidian_patch_file\` (insert).
- Use \`[[wiki links]]\` liberally so the graph stays connected.

## At the END of a task (always)

Append a short structured entry to today's session note
\`${MEMORY_SKILL_VAULT_FOLDER_TOKEN}/Sessions/YYYY-MM-DD-<agent>.md\` using \`obsidian_post_file\`
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

Remember: \`obsidian_post_file\` will report \`Unexpected end of JSON input\` even
though the session note was appended successfully. Do not retry it — that
duplicates the entry.

## Conventions

- Note names: kebab-case for Decisions/Entities (e.g. \`auth-token-rotation\`).
- Never delete another agent's notes; correct by adding, not erasing.
- Prefer linking to duplicating: if a fact exists, link it.
`;

/**
 * Renders the given memory skill template (default: the built-in one) for one
 * project by substituting its vault-relative folder.
 */
export const renderMemorySkillTemplate = (vaultFolder: string, template?: string): string =>
  (template ?? MEMORY_SKILL_TEMPLATE).replaceAll(MEMORY_SKILL_VAULT_FOLDER_TOKEN, vaultFolder);

export const buildMemorySkillContent = (vaultFolder: string): string =>
  renderMemorySkillTemplate(vaultFolder);
