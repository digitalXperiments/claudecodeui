# CloudCLI 3–4× Speed Plan

Status: proposed · 2026-09-25
Inspired by: "How we made claude.ai faster" (3.1× geometric-mean speedup over 13 RUM measurements in 2 weeks).

## Principles borrowed from the article

1. **Measure first — a metric makes it tractable.** Every change is tied to a journey measurement with a lab benchmark that reproduces it.
2. **Journeys, not components.** Each measurement starts at a user action and ends when the result is rendered. Client and server time are split.
3. **Deterministic lab benchmarks** (instruction counts, React commit counts, layout/reflow counts, bundle bytes) for fast iteration; field numbers to confirm.
4. **Ship behind flags, ratchet benchmarks.** CI allows a metric to improve, never regress; a daily job lowers the ceiling.
5. **Small PRs, flag off if it doesn't move the needle.** Human "taste" gate: reject complexity for tiny wins.

Target: **≥3× geometric mean** across the journeys below.

## Journeys and estimated baselines

| # | Journey (start → end) | Estimated baseline | Target | Main lever |
|---|---|---|---|---|
| J1 | Cold load → composer usable (web, remote) | ~3.8 MB JS raw (1.1 MB gz) + 5 serial round trips | 3–5× | Compression, fix broken lazy chains, i18n split, static shell, parallel bootstrap |
| J2 | Send follow-up → first token (Claude) | 2–8 s cold CLI spawn + 7 MCP servers every turn | 5–10× | Keep SDK sessions warm |
| J3 | Keystroke → paint while streaming | Full transcript re-render + forced reflow per key and per 100 ms flush | 3–5× | Move store and input state out of ChatInterface, fix memo |
| J4 | Open existing session → last message rendered | Full JSONL re-parse on cache miss; 20-row pages loaded in a loop | 2–4× | Incremental JSONL, larger first page, hover prefetch |
| J5 | Sidebar / `GET /api/projects` | Sync across 12 providers + 3,475 stats per call (0.3–1.5 s) | 5–10× | Serve from DB only |
| J6 | New session appears in sidebar | 6 s polling + 0.5–2 s debounce | 5× | Native FSEvents watcher |
| J7 | Long reply main-thread blocking (TBT) | Collapsed diffs and thinking fully rendered; O(m·n) LCS diff; re-highlighting unclosed fences | 3× | Lazy collapsibles, Myers diff, deferred highlighting |

---

## Phase 0 — Instrumentation (days 1–2, blocking)

- **Client RUM marks** (`performance.mark/measure`) for J1–J7, posted to `POST /api/perf` and stored in SQLite with build SHA and platform (web / mweb / desktop).
- **Server timing:** `Server-Timing` header on `/api/projects` and session history; span log for `chat.send → spawn → first stream_delta`.
- **Lab benchmarks** under `tmp/cloudcli/perf/` (Playwright + cached headless Chromium, see the prototype-verification pattern):
  - bundle bytes on the startup path (parse `dist/index.html` modulepreloads);
  - React commits per keystroke and per stream flush (React Profiler API in a test build);
  - forced-reflow count (`PerformanceObserver` long tasks + layout-shift);
  - `/api/projects` p50 against a fixture `~/.claude/projects`;
  - time to first token against a stub CLI (no real model calls).
- **Ratchet file** `perf-budgets.json` checked in CI (`npm run perf:check`): fail if any number gets worse.

## Phase 1 — Quick wins (days 2–4) · mostly config, low risk

| Change | Where | Journey |
|---|---|---|
| Brotli/gzip precompressed assets (`vite-plugin-compression2` + `express-static-gzip`) or `compression()` | `vite.config.js`, `server/index.js:624-640` | J1 (direct/LAN; tunnel already gzipped by nginx) |
| Move `express.static(public)` after `dist` | `server/index.js:624` | J1 |
| SQLite pragmas: WAL, `synchronous=NORMAL`, `busy_timeout`, `cache_size`, `mmap_size`, `temp_store=MEMORY`; hoist prepared statements | `server/modules/database/connection.ts:113` | all |
| Mount `authenticateToken` once instead of 9 times | `server/index.js:534-549` | all API |
| `UV_THREADPOOL_SIZE=16` in LaunchAgent/env | launch plist | J4, J5 |
| Remove the per-event "Session synchronization triggered" log (114k lines) | `sessions-watcher.service.ts:271` | background |
| nginx: `upstream` keepalive + `proxy_buffering off` on 8093 | `/opt/homebrew/etc/nginx/servers/websites.conf` | J1–J4 via tunnel |
| Self-host fonts, drop render-blocking Google Fonts link | `index.html:11-17` | J1 |
| Register the service worker once | `index.html:66-78`, `main.jsx:39` | J1 |

## Phase 2 — Warm agent sessions (days 3–7) · biggest single win (J2)

- Replace `RUN_DRAIN_GRACE_MS = 750` (`server/claude-sdk.js:77`, `:1079-1106`) with a **per-session idle TTL (5–10 min)**. Follow-ups use the existing `injectClaudeMessage` path (`:1455`). Evict on TTL, on model/permission-mode change, or on memory pressure (cap N warm sessions).
- **Pre-warm** on `chat.subscribe` when the user opens a session and focuses the composer (behind a flag; cap concurrency).
- **Cache per-turn setup:** `applyClaudeSpawnAuthEnv` (Keychain `security` spawn) with a 60 s TTL; `loadMcpConfig` (109 KB `~/.claude.json`) keyed on mtime; `resolveResumeModel`.
- **Check whether MCP servers load twice** (`settingSources: user` plus explicit `mcpServers` from the same file). Consider `ENABLE_CLAUDEAI_MCP_SERVERS=false` for chat runs.
- Apply the same warm-process model to Codex `app-server` (`codex-app-server.js:204`). Grok and Kimi already reuse ACP sessions.
- Flag: `perf.warmClaudeSessions`.

## Phase 3 — Chat render path (days 4–9) · J3, J7

1. **Isolate re-renders.** Move `useSessionStore()` out of `ChatInterface.tsx:93` into a `useSyncExternalStore` selector subscribed only by `ChatMessagesPane`. Move composer `input` state into `ChatComposer`.
2. **Make memo hold.** Stabilize the inline `setProvider` (`ChatInterface.tsx:892`) and the composer callbacks (`:1004-1045`); `React.memo` on `ChatComposer`, `LazyMessageRow` (pass the item, not children) and `ToolGroupContainer`.
3. **Stop per-render forced reflow.** Give the `useLayoutEffect(reconcile)` in `useChatSessionState.ts:1145` real dependencies; rely on the ResizeObserver.
4. **Lazy collapsibles.** Mount `CollapsibleContent` children only when open (`shared/view/ui/Collapsible.tsx:79`).
5. **Diff.** Replace the O(m·n) LCS (`messageTransforms.ts:9-28`) with `diff`'s Myers `diffLines`, size-capped, in a Web Worker for large inputs. Key the cache on a hash, not `JSON.stringify`.
6. **Streaming markdown.** Render unclosed fences as plain `<pre>` while streaming and highlight once closed. Make the settled/pending split incremental (remember the offset). Split lists at item boundaries.
7. **Highlighter one-byte trick (from the article).** Copy code to a Latin-1-safe string before Prism when the text contains non-Latin-1 characters, and benchmark it (the article saw 250 → 35 ms).
8. **App-level cascade.** `useCallback` for the `AppContent`/`MainContent` props (`AppContent.tsx:366-376`, `MainContent.tsx:337`); `memo(Sidebar)`; drop `isInputFocused` from app state; keep `selectedProject` identity when only `lastActivity` changes.
9. **Status bar.** Stop `setHeartbeat` per raw delta (`useSessionStatusBarTelemetry.ts:374`); publish on the 1 s tick instead.

## Phase 4 — Launch path (days 5–10) · J1

- **Break eager chains that pull xterm and CodeMirror (~326 KB gz):**
  - `ProviderSelectionEmptyState.tsx:14` → import `NextTaskBanner` directly, not from the `task-master` barrel;
  - lazy `TaskMasterSetupModal`, `Onboarding` in `ProtectedRoute.tsx:4`, `ProviderLoginModal`, and `SkillWizardDialog` (`ChatInterface.tsx:33`).
  - Verify that `vendor-xterm` and `vendor-codemirror` disappear from `dist/index.html` modulepreload.
- **i18n:** load non-English locales on demand (`i18next-resources-to-backend`). Saves ~440 KB raw from the entry chunk.
- **Markdown/KaTeX/highlight on demand:** lazy `Markdown`; load KaTeX plus its CSS only when math is detected; register Prism languages on demand. Component-level lazy only — **do not** change `manualChunks` for the remark graph (known init-order crash).
- **`vendor-utils`:** move `jszip` and `yaml` out of the eager chunk (`vite.config.js:79`).
- **Static shell (article's biggest launch win, 5.6×):** render a static copy of the app frame and composer into `index.html` at build time (jsdom render of the real components), then hand off to React without losing keystrokes. Keystroke-handoff test required.
- **Parallel bootstrap:** replace the status → user → onboarding → projects chain with one `GET /api/bootstrap`, fired from an inline script while JS downloads. Remove the duplicate `/api/projects` fetch in `TaskMasterContext.tsx:328`. Delay the GitHub version check to idle.
- **Prune stale `dist/assets`** (1,156 files, 142 MB) and the service-worker cache; enable asar for desktop.

## Phase 5 — Server data paths (days 6–12) · J4, J5, J6

- **`/api/projects` from DB only** (`skipSync` by default); full sync only at boot or on explicit Refresh; one shared in-flight sync promise. Cache display names; remove the per-project `loading_progress` broadcast (`projects-with-sessions-fetch.service.ts:185-270`).
- **Watcher:** `usePolling: false` (FSEvents) on macOS (`sessions-watcher.service.ts:321`); cache the `history.jsonl` map by mtime; read the transcript tail to find titles instead of the whole 20 MB file.
- **Incremental JSONL:** keep a byte offset per transcript and parse only appended lines (`claude-sessions.provider.ts:104-186`). Cache other providers by their own change signal. Pre-parse timestamps for sorting.
- **History UX:** first page 50–100 rows; hover/focus prefetch in `SidebarSessionItem`.
- **Streaming hot path:** forward events to the client *before* `recordNormalizedRunEvent`; batch inserts every ~50 ms in one transaction; scope `run_event` broadcasts to the run's subscribers; cap tool-result payload size; prune `agent_run_events` (97 MB) more often.
- **Boot:** move article studio setup, the relay integration sync and the mission-control drain to after `listen`.

## Phase 6 — Longer bets (after re-measuring)

- Virtualize the transcript (react-virtuoso reverse mode or `@tanstack/react-virtual`); the height cache and row keys already exist.
- Move markdown parse and highlight to a worker for long replies.
- Bundle the server for desktop; V8 code cache via `loadFile`/custom protocol with `v8CacheOptions: 'bypassHeatCheck'`.
- Consolidate the ~15 client polling intervals into WS push.

## Guardrails

- Each change behind a `perf.*` flag in settings; default on only after its benchmark ratchets down.
- Unit test before optimizing (merge, diff, streaming split, JSONL offset parser).
- Warm sessions: tests for eviction, model switch, permission-mode change, crash recovery, and memory cap.
- Static shell: layout-shift budget of 0 in the Playwright test at multiple viewports, plus a keystroke-handoff test.
- Never run e2e against the live 3001 server; use the isolated e2e server.

## Expected outcome (estimates to validate in Phase 0)

| Journey | Estimated speedup |
|---|---|
| J1 cold load | ~3.5× |
| J2 first token on follow-up | ~5× |
| J3 typing/stream latency | ~4× |
| J4 open session | ~2.5× |
| J5 projects list | ~6× |
| J6 sidebar freshness | ~5× |
| J7 long-reply TBT | ~3× |
| **Geometric mean** | **~3.9×** |
