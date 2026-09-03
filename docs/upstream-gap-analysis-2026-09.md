# Upstream Gap Analysis — siteboon/claudecodeui

**Date:** 2026-09-02
**Merge-base:** `27eaf014` (v1.36.3, 2026-07-15)
**Upstream head analyzed:** `99ea0525` (upstream/main, 2026-09-01)
**Gap:** 21 commits, spanning upstream releases v1.37.0 → v1.37.2 plus PR #1206.

Our fork has diverged heavily (own module layout under `server/modules/`, fork-only
features: agent-relay, swarm, mission-control, workspaces, kanban, studio, evals, …).
**A wholesale merge of upstream/main is not feasible** — upstream deleted
`server/index.js`/`server/cli.js` in a TypeScript restructure and #1206 renamed
essentially the entire `src/` tree (`src/components/**` → `src/modules/**`, 702 files).
Everything below is therefore a per-change assessment: what upstream did, whether we
already have an equivalent, and how to take it if we want it.

---

## TL;DR — what actually matters

| Priority | Item | Upstream commit | Effort |
|---|---|---|---|
| 🔴 Port now | Claude conversation search matches by `provider_session_id` (search is silently broken for app-created sessions today) | `95076941` | ~12 lines, near-clean cherry-pick |
| 🔴 Port now | `CLAUDE_CODE_OAUTH_TOKEN` in credential checks (false "expired" states) | `75ff8a5d` | 2 small blocks in `claude-auth.provider.ts` |
| 🔴 Port now | Single-dollar math fix (`$20/psf` gets eaten as LaTeX in chat markdown) | part of `06e7ee9f` | 1 line in `Markdown.tsx:192` |
| 🔴 Port now | Shell PTY stale-socket owner guard + WS pong/terminate heartbeat (reconnect can kill your own PTY on mobile) | part of `06e7ee9f` | 2 small hunks |
| 🔴 Port now | Don't recurse into forbidden system dirs in file tree (`/proc` burns the whole FS budget) | `753a8c04` | 3 lines in `server/index.js:1936` |
| 🟠 High value, re-implement | Bounded latest-page transcript refresh + refresh coordinator (we still download the **entire transcript** on every `complete`/reconnect, even in hidden tabs) | `0a2ad343` | Medium — 2 copyable new files + rewiring 2 call sites |
| 🟠 High value, re-implement | Server-side session-history LRU cache (`session-history-cache.service.ts`) — we re-parse the full JSONL on **every** page request | part of `99ea0525` | ~1 new file + ~20-line hook-in at `sessions.service.ts:228` |
| 🟠 High value, re-implement | `LazyMessageRow` + `useLazyRowObserver` (29k-row session: ~112 MB vs ~1 GB) | part of `99ea0525` | 2 self-contained files + ~15 lines in `ChatMessagesPane` |
| 🟠 High value, re-implement | `StreamingMarkdown` split (streaming reply re-parses whole message 10×/s → O(n²)) | part of `99ea0525` | 2 files + memoized export from our `Markdown.tsx` |
| 🟢 Take wholesale | `docs/architecture/01–06` (chat-runtime architecture docs — invariants our fork shares) | `99ea0525` | `git show 99ea0525:docs/architecture/<file>` |

---

## Status of all 21 commits

Legend: ❌ missing · ✅ have equivalent · ➖ N/A (deliberate divergence / different design) · ⚠️ partial

### v1.37.0 chunk

| Commit | What it does | Our status | Verdict |
|---|---|---|---|
| `75ff8a5d` | `checkCredentials()` honors `CLAUDE_CODE_OAUTH_TOKEN` (env + `~/.claude/settings.json` env block); without it long-lived OAuth tokens show false "expired" | ❌ `claude-auth.provider.ts:297-316` checks ANTHROPIC_* only; zero repo hits for the var | **Port by hand** — insert after line 313 |
| `06e7ee9f` (#1037, 254 files) | ~25 squashed PRs; see breakdown below | mixed | Cherry-pick pieces only |
| `753a8c04` | File tree skips recursion into `FORBIDDEN_WORKSPACE_PATHS` (e.g. `/proc`) | ⚠️ Our `getFileTree` (`server/index.js:1842`) has entry/time budgets (20k / 15s) so we degrade instead of hang, but still burn the budget on procfs | **Port** — helpers (`FORBIDDEN_WORKSPACE_PATHS`, `normalizeProjectPath`) already exist in `server/shared/utils.ts` |
| `c2408f0f` | Relabel "Sonnet 4.6"→"Sonnet 5" in fallback model list | ➖ We made fallback descriptions generation-agnostic by design (`claude-models.provider.ts:31-38`) + live CLI probe | **Skip** — porting reintroduces the bug class |
| `428b1052` | Copy app/provider session IDs: `GET .../sessions/:id/provider-id` + sidebar ActionMenu | ❌ No route, no `getProviderSessionId`, no copy UI | Backend is ~30 safe lines (`provider_session_id` column exists, `schema.ts:134`); hand-write minimal UI against our own ActionMenu — upstream's needs an ActionMenu API expansion |
| `badad381` zh-CN, `59472c07` ko, `5fa87dda` es | i18n completion + new `tasks.json` namespace; es is a whole new locale (7 files) | ⚠️ Our `en` drifted ahead (488 settings keys vs upstream ~380), so these close ~half our zh-CN/ko settings gap, all of codeEditor, and 100% of the missing `tasks.json` (zh-CN + ko have no tasks file at all). `es` absent entirely | **Take, but merge key-by-key** — our zh-CN/ko `sidebar`/`common` are AHEAD of upstream; never overwrite wholesale. `es` also needs a hand-written `es/skills.json` (fork-only namespace) + registration in `languages.js`/`config.js` |

#### `06e7ee9f` breakdown (the "numerous bugfixes" mega-commit)

| Sub-change | Our status | Verdict |
|---|---|---|
| Server TS restructure (deletes `server/index.js`/`cli.js`, new `server/modules/{agent,auth,cli,commands,file-tree,git,plugins,system,voice,worktrees}`) | ➖ We built our own 30-module layout | **Skip** — collides head-on |
| Shell WS: stale-socket owner guard (`if (session.ws !== ws) return`) + heartbeat `pong`/`terminate()` | ❌ `shell-websocket.service.ts:1079-1105` has no owner check; `websocket-server.service.ts:38-52` pings but never terminates | **Port** (guard must go before our `captureShellSessionSync()`; skip their DI-removal half) |
| Abort-before-provider-id: runtimes keyed by app session id so aborting a session's first run works | ❌ same bug at `chat-websocket.service.ts:449-453` — abort skipped when `providerSessionId` null; CLI keeps running while UI clears | **Re-implement the idea narrowly** — don't port the refactor (our most-rewritten area) |
| Markdown: `singleDollarTextMath: false`, `remark-breaks`, list components, user bubbles as Markdown | ❌ `Markdown.tsx:192` still eats `$20/psf` as LaTeX | **Port the one-liner now**; user-bubble change is cosmetic, selective |
| `ToolErrorDisplay` + Bash rows stop auto-expanding on error | ❌ ours does the opposite (`BashCommandDisplay.tsx:46` auto-expands on error) | Product decision, not a bug — decide deliberately |
| Chat export (MD/HTML/PDF): `chatExport.ts` + `ChatExportMenu` | ❌ | Additive, low risk — good candidate |
| Worktrees module + git-panel tab | ✅ our `server/modules/workspaces/` is more developed (mutex, 3 merge strategies, sandbox_copy fallback) | **Skip entirely** |
| One-click `git init` (`POST /api/git/init` + button) | ❌ `GitRepositoryErrorState.tsx:21` just tells the user to do it | Small UX win — add to our `server/routes/git.js` |
| Session deep-link: `GET /api/providers/sessions/:sessionId` resolves id → project | ❌ we have DELETE/PUT but no GET | Moderate; frontend half lands in reworked code |
| Per-session model persistence (`sessions.model` column; deletes the active-model-changes sidecar) | ❌ we're still on `provider-session-active-model-changes.json` (`server/shared/utils.ts:586,722`); no `model` column in `schema.ts:126-154` | **Re-implement, don't port** — better design, but deep in areas we rewrote + agent-profiles/relay model overrides layered on top |
| `~/.codex/skills` home-scope discovery | ✅ `codex-skills.provider.ts:54` | Nothing to do |
| Filter injected Skill bodies from live streams ("Base directory for this skill:") | ❌ zero hits | Small, self-contained — port |
| Hide gitignored files from `@` mentions | ❌ `useFileMentions.tsx` has no ignore logic | Nice-to-have |
| Version-upgrade auto-refresh + non-JSON update-response guard | ❌ `VersionUpgradeModal.tsx:67` | Nice-to-have |
| File attachments across providers (`ChatMessageFiles` render path) | ⚠️ we have composer-side attachments but no message-render path | Selective |
| Composer decomposition, QuickSettingsPanel move, `sessionMessageReconciliation.ts` | ➖/❌ we decomposed differently | Skip / revisit with transcript work |

### v1.37.1 chunk

| Commit | What it does | Our status | Verdict |
|---|---|---|---|
| `f0dca2d5` | 60s clock-skew tolerance in client JWT expiry check | ➖ we never adopted client-side claim decoding; our 401-confirm probe (`src/utils/api.js:14-41`) covers the bug class | **Skip** |
| `74d3f8ff` | `tsx --tsconfig server/tsconfig.json --test` so `@/` aliases resolve in server tests | ✅ `package.json:50`, we went further (split test:server/test:client) | Nothing to do |
| `ca92373d` | Recommend Codex Usage plugin in plugin settings | ❌ (we also never got its predecessor, Claude Usage) | Trivial copy if we want parity |
| `ef3f7980` | Delete dead `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` workaround; document `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` in `.env.example` | ❌ we carry **two** copies of the dead code (`server/claude-sdk.js:927-928,955-959` and `1077-1078,1096-1098`; provably dead — env snapshotted at line 267) | **Hand-apply deletion** + take the `.env.example` doc line |
| `015e892c` | Server-paginated recent-conversations feed (`GET /sessions/recent`, `getRecentSessionsPage`) | ⚠️ we have a client-side equivalent (`useSidebarController.ts:917-950`) that flattens only already-loaded projects — upstream's commit message names our exact limitation | UI: don't port (our sidebar is heavily rewritten). Server half is self-contained — take only if completeness/pagination matters |
| `0f67810c` (#1095, 51 files) | Codex SDK 0.144→0.146 + 7 unrelated fixes | mixed — see below | **Do not cherry-pick whole** |
| `95076941` | Conversation search maps transcript lines via `provider_session_id` → internal id | ❌ we have the pre-fix code **byte-identical** (`session-conversations-search.service.ts:790-793`) — Claude search silently returns nothing for app-created sessions | **Port first** — near-clean cherry-pick, 1 file |
| `0d517749` | Atomic dist-server promotion + `recover` preserver hook | ✅ our `scripts/build-server.mjs` predates/exceeds it (also copies agent-relay skill assets). Two real gaps: no `recover` mode if promotion is interrupted mid-rename; `server/tsconfig.json:26` outDir still points at live `dist-server` (bare `tsc -p` would clobber it) and `exclude` misses `dist-server.next` | Hand-edit the two gaps; don't take their script |

#### `0f67810c` breakdown

| Sub-change | Our status | Verdict |
|---|---|---|
| `@openai/codex-sdk` 0.144→0.146 | ❌ pinned `^0.144.0` (`package.json:155`); caret may float | Bump deliberately |
| File-tree 10k-entry cap → HTTP 413 | ✅ our budget system is stronger — but we truncate **silently** | Pair with next item |
| Surface file-tree errors in UI | ❌ `useFileTreeData.ts:50-67` only console.errors; huge roots show a partial tree with no explanation | **Best-value item here** — port |
| Customizable model library (catalogs + custom models CRUD + `ModelLibraryPanel`) | ❌ entirely; our `provider-models.service.ts` still uses the old fetch-and-cache design upstream deleted | Independent feature — evaluate on merits |
| Per-session reasoning-effort persistence | ✅ `useChatProviderState.ts:60-69,739,971-983` | Nothing to do |
| Session naming: upstream **deleted** `extractFirstUserMessageFromStart` in favor of nameMap | ➖ we still have (and use) that code (`codex-session-synchronizer.provider.ts:143-149`) | **Do not port** — it's a reversal of behavior we want |
| Codex non-bash tool call regexes | ➖ different code path in our `codex-sessions.provider.ts:202-230` | N/A |
| Mobile rename bottom sheet | ➖ our rename UX differs | N/A |

### v1.37.2 + head

| Commit | What it does | Our status | Verdict |
|---|---|---|---|
| `0a2ad343` (#1153, ~150 files) | **The bandwidth fix**: bounded newest-page refresh (`refreshLatestFromServer`, page size 20), `messageHistoryRefreshCoordinator` (visibility-gated, coalescing), `sessionMessagePagination` bridge helpers. Plus ~20 unrelated fixes (Claude background-agent lifetime, Claude orphaned-query CPU-leak fix, gitignore-authoritative Files view, git force-delete, mermaid, session-title search ranking, page title = session title, …) | ❌ **we still have the exact bug**: `useSessionStore.ts:349-357` downloads the entire transcript with no limit/offset on every `complete`/reconnect/external update, with no visibility gating (`useChatSessionState.ts:576,658`) — megabytes per turn on long sessions, even in hidden tabs | **Re-implement** — coordinator + pagination helpers are dependency-free and copyable verbatim; add `refreshLatestFromServer` beside our `refreshFromServer`; keep our `_fetchSeq` ticketing and `pruneRealtimeSupersededByServer`. Check the Claude CPU-leak fix separately against `server/claude-sdk.js` |
| `99ea0525` (#1206, 702 files, +39.5k/−14k) | (a) whole-frontend `src/modules/` migration + oxlint + vitest; (b) provider unification: `message-unification.ts`, unified edit-and-resend (`chat.edit-send` + `history_truncated`), session forking (`*-fork.provider.ts` + capability-driven UI), Codex parity (+2.3k lines, app-server client), single `session_upserted` builder, scheduled messages, server-persisted prefs/drafts; (c) transcript perf: server LRU history cache, `LazyMessageRow`, `StreamingMarkdown`, PrismLight, `content-visibility` on mounted rows; 6 architecture docs | ❌ almost all of it. Notables: we deliberately removed `content-visibility:auto` (`src/index.css:613-623`) due to streaming flicker — `LazyMessageRow`'s measured-height placeholders are the principled fix for exactly that; our two `session_upserted` builders (`sessions-watcher.service.ts:207`, `chat-run-registry.service.ts:149`) have the same divergence bug upstream consolidated; we already have equivalents of the pagination/store fundamentals (slot store, tail-offset paging, seq replay, `MAX_REALTIME_MESSAGES`) | **Selective re-implementation** in the priority order below. Skip the module migration, oxlint, `src/shared/api.ts`, server-persisted settings, scheduled messages. Edit-and-resend + forking = fresh feature work informed by upstream's design |

---

## Recommended sequence

**Phase 1 — quick correctness wins (hours):**
1. `95076941` search fix (cherry-pick, 1 file).
2. `75ff8a5d` OAuth token env checks.
3. Single-dollar-math one-liner (`Markdown.tsx:192`).
4. Shell PTY owner guard + WS pong/terminate.
5. `753a8c04` file-tree forbidden-path guard.
6. `ef3f7980` dead-code deletion ×2 + `.env.example` line.
7. `0d517749` gaps: `recover` mode in `build-server.mjs`, fix `server/tsconfig.json` outDir/exclude.

**Phase 2 — performance (the real payoff, ~days):**
1. Server-side `session-history-cache.service.ts` + `sliceTailPage` (highest value, near-zero coupling — hook at `sessions.service.ts:228`).
2. Bounded latest-page refresh + `messageHistoryRefreshCoordinator` (kills full-transcript downloads per turn).
3. `LazyMessageRow` + `useLazyRowObserver` (verify against our streaming/tool rows and Grok before re-enabling anything `content-visibility`-like).
4. `StreamingMarkdown` + `syntaxHighlighter.ts` (PrismLight).
5. Consolidate `session_upserted` into one builder.

**Phase 3 — features to evaluate individually:**
chat export, git init button, session-ID copy actions, file-tree error surfacing, session deep-link GET, i18n merges (key-by-key) + es locale, gitignore-aware mentions, skill-body stream filter, Codex SDK bump, model library, per-session model column (re-design, integrating agent-profiles/relay overrides), edit-and-resend + session forking (fresh work), `message-unification.ts` (only if we want one checklist/ask renderer — ours must also cover Grok/ACP/OpenCode).

**Take regardless:** upstream's `docs/architecture/01–06` (`git show 99ea0525:docs/architecture/<file>`) — they document invariants our fork shares (one `complete` per run, provider ids never on the wire, live-rows-as-overlay, tail-offset paging).

**Explicitly do not take:** server TS restructure, `src/modules/` migration, worktrees (we have workspaces), Sonnet label edits, Codex session-naming reversal, composer decomposition, upstream's promote-dist-server script.

---

## In-flight upstream branches (not on upstream/main yet)

- `fix/interrupt-a-busy-run-instead-of-failing-to-send-for-scheduled-messages` — scheduled-messages interrupt fix + a chat fix for answered permission prompts reappearing on mid-run refresh (`49077472`, potentially relevant to us independently of scheduled messages).
- `perf/chat-and-project-loading` — command-palette/portal perf + effect-hygiene fixes.
- `react-doctor-changes` — React lint-driven cleanups.

Re-check these next sync; they'll likely land on main.

---

*Generated by fan-out analysis of `git log 27eaf014..upstream/main` against our HEAD (`2ad79b7`). To refresh: `git fetch upstream` and re-run the per-commit comparison.*
