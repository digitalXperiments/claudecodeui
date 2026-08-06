---
name: memory
description: Use the project's Obsidian vault as a shared second brain. Read it for context at the start of EVERY task and write proceedings, decisions, and durable facts back to it. Any agent (Claude, Codex, Cursor, Grok, Kimi, etc.) with the Obsidian MCP server should follow this.
---

# Memory — Obsidian second brain (agent-agnostic)

This project keeps a persistent memory in an Obsidian vault. Your job is to
**read it before you act and write to it as you work**, so the next agent — in
this session or a future one — inherits everything you learned. Treat it as
shared team knowledge, not a scratchpad.

## STRICT RULE — all temp activity goes in `tmp/cloudcli/`

Never scatter temporary folders or scratch files around the repo, your home
directory, `/tmp`, or the OS temp dir. **Any** temp activity — scratch dirs,
downloaded assets, session artifacts, sandboxes, caches — **must** live under
the project root's `tmp/cloudcli/` directory. This applies to **every**
provider and every session.

- Create it if missing: `mkdir -p tmp/cloudcli`.
- Use a subfolder per task/agent for isolation: `tmp/cloudcli/<task>/`.
- Remove your own leftovers when done.
- Non-negotiable: a stray temp dir outside `tmp/cloudcli/` is a violation and
  must be corrected.

You reach the vault through the **Obsidian MCP server** (`@fazer-ai/mcp-obsidian`,
backed by the Local REST API plugin). Use these **exact** tool names and argument
names — do not guess or invent them. The `filename` argument is **required** and
must be the **full vault path including the `.md` extension** (e.g.
`MEMORY_ROOT/00-Overview.md`).

| Purpose | Tool | Required args | Notes |
| --- | --- | --- | --- |
| Check the vault is reachable | `obsidian_status` | (none) | |
| Full-text search | `obsidian_simple_search` | `query` (string) | Optional `contextLength` (number, use ~50) and `limit` (number, default 20 files). Returns `{ results, truncated? }`. |
| List a folder | `obsidian_list_vault_directory` | `pathToDirectory` (string) | Use `obsidian_list_vault_root` (no args) for the root. |
| Read a note | `obsidian_get_file` | `filename` (string) | Full path incl. `.md`. |
| Create / overwrite a note | `obsidian_put_file` | `filename`, `content` (strings) | Replaces the whole file. |
| Append to a note (creates it if missing) | `obsidian_post_file` | `filename`, `content` (strings) | Use for Session logs. |
| Insert relative to a heading / block | `obsidian_patch_file` | `filename`, `operation`, `targetType`, `target`, `content` | `operation`: `append`/`prepend`/`replace`; `targetType`: `heading`/`block`/`frontmatter`. |

There is **no dedicated backlinks tool**, but `obsidian_get_file` already returns
`links` and `backlinks` for the note it reads — use those first. Only fall back to
`obsidian_simple_search` for `[[note-name]]` when you need matches inside notes you
have not read.

**Keep searches narrow.** `obsidian_simple_search` scans the whole vault, and a
broad one- or two-word query can return tens of thousands of characters and
overrun the tool-output limit. Use specific multi-word queries, pass
`contextLength: 50`, and prefer `obsidian_list_vault_directory` +
`obsidian_get_file` when you are browsing rather than searching. Results are
capped at 20 files and 5 matches per file; a `truncated` field in the response
means you should narrow the query rather than raise `limit`.

> If these tools are not available, the Obsidian MCP server is not connected —
> tell the user and continue without memory rather than guessing.

## Configure me (one line, per project)

Set the project's folder inside the vault. Everything below is relative to it.

```
MEMORY_ROOT: Projects/<this-project>
```

All paths in this skill mean `MEMORY_ROOT/<path>` (e.g. `MEMORY_ROOT/00-Overview.md`).

## Folder layout

- `MEMORY_ROOT/00-Overview.md` — canonical summary: goals, constraints, stack. The home note.
- `MEMORY_ROOT/Index.md` — map of content (MOC); links to everything.
- `MEMORY_ROOT/Decisions/` — one note per decision (ADR-style: what, why, alternatives, date).
- `MEMORY_ROOT/Entities/` — services, endpoints, people, glossary terms — the wiki nodes.
- `MEMORY_ROOT/Sessions/` — append-only dated logs, one note per day (`YYYY-MM-DD-<agent>.md`).

## At the START of every task (always, before acting)

1. `obsidian_status` — confirm the vault is reachable.
2. `obsidian_get_file` `MEMORY_ROOT/00-Overview.md` to load the project frame.
   - If it (or the folder) does not exist, **bootstrap** it: `obsidian_put_file`
     a starter `00-Overview.md` and `Index.md`, then continue.
3. `obsidian_simple_search` for terms relevant to your task — specific
   multi-word phrases, with `contextLength: 50`; read the top hits with
   `obsidian_get_file`.
4. For any note central to your task, skim the `links` / `backlinks` returned by
   `obsidian_get_file` to find related context.

Do this before writing code or making decisions — prior context prevents
re-litigating settled questions.

## DURING the task (promote knowledge as you go)

- **Decision made?** `obsidian_put_file` `MEMORY_ROOT/Decisions/<slug>.md` (what,
  why, alternatives, date) and add a `[[link]]` to it from `Index.md`.
- **Learned a durable fact** about a service/endpoint/person/term? Create or update
  the matching note in `MEMORY_ROOT/Entities/` with `obsidian_put_file` /
  `obsidian_patch_file`.
- Use `[[wiki links]]` liberally so the graph stays connected. Prefer linking to
  an existing note over duplicating a fact.

## At the END of every task (always — this is the "write everything" step)

Append a structured entry to today's session note
`MEMORY_ROOT/Sessions/YYYY-MM-DD-<agent>.md` with `obsidian_post_file` (it creates
the file if missing):

```
## <HH:MM> — <one-line summary>
- **Did:** what changed / what you produced
- **Why:** the reason, if not obvious
- **Decisions:** [[links to any Decisions notes created]]
- **Files:** key files touched
- **Open:** anything left unresolved for the next agent
```

Always leave a trace, even a single line, so the timeline stays continuous. If you
made notable decisions or discovered facts, they belong in Decisions/Entities
(above) with a link from the session entry — not buried only in the log.

## Conventions

- Note names: kebab-case for Decisions/Entities (e.g. `auth-token-rotation`).
- Never delete or overwrite another agent's notes to "correct" them — add a new
  note or append; link the old one.
- Keep entries terse and factual.
- Scope strictly under `MEMORY_ROOT/`; do not write elsewhere in the vault.
