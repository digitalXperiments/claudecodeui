# Issue: Chatbar / sidebar “running” count does not match sessions the user can see or switch to

**Status:** In progress (2026-08-22) — running list is no longer filtered through the paginated project page; session switcher pins every live id.  
**Severity:** High (trust-breaking: UI says work is happening, but the user cannot find the other session)  
**Related:** Prior fix treated live Shell PTYs as “running” even at an idle `>` prompt. That was one slice. This issue is the remaining **source-of-truth split** across Chat, Shell, sidebar, and the session switcher.

---

## Observed (2026-08-22 screenshot)

- Left **activity rail badge** shows **2** (green).
- Chat header session switcher is open for **CloudCLI Fork**.
- Dropdown lists **exactly one** session: *Generate Swarm Goals from Agent Problem Statements* (`<1m`).
- Search is empty (no filter hiding rows).
- The project itself reports **501** sessions, so the switcher is **not** a full project catalog.

User mental model: “Running 2” ⇒ I can open a list of those 2 sessions and jump to the other one.

Actual UI: the badge is a **global processing-map size**. The dropdown is **this project’s currently loaded session page**, not “running sessions”.

---

## Product expectation (acceptance)

There must be **one** definition of “running” used everywhere:

1. Count (rail badge, “Running now” header).
2. List (running sidebar mode).
3. Chat composer / activity indicator / abort.
4. Any “switch to the other live session” UI.

For every `sessionId` in that set:

- It is a **real app session** the user can open.
- It appears in **Running now** immediately (no pagination miss).
- If the chat header is used as a jump list while work is live, **every running session is listed** (at least pinned at the top), including ones in other projects and ones not on the current page of 501 sessions.
- Idle TUI (`>`, shortcut chrome) is **not** running.
- A live Chat turn **is** running even if Shell is idle (and vice versa).
- Count === list length. Always.

If a session cannot be shown in the switcher / sidebar, it **must not** increment the badge.

---

## Architecture: too many clocks

Running state is assembled from independent stores that do not share a schema or a UI consumer.

| Layer | Location | What it means today |
| --- | --- | --- |
| Chat run | `chatRunRegistry` (`server/modules/websocket/services/chat-run-registry.service.ts`) | Provider Chat websocket run is in flight |
| Shell TUI busy | `shellSessionRegistry` + `classifyTuiActivity` (`shell-session-registry.service.ts`, `shell-tui-activity.ts`) | PTY looks busy (interrupt chrome / spinner / thinking), or just after Enter |
| HTTP snapshot | `GET /api/providers/sessions/running` → `sessionsService.listRunningSessions()` | Union of chat + shell, skip shell if same id already in chat, require a DB row |
| WS hint | `running_sessions_changed` (`run-events.ts`, subscribed in `AppContent.tsx`) | Triggers a refetch of the HTTP snapshot |
| Client map | `useSessionProtection` `processingSessions` | Synced from HTTP; **chat** entries get a **10s grace** if missing from the snapshot; **shell** does not |
| Badge | `useSidebarController`: `runningSessionsCount = activeSessionIds.size` | **Global** map size |
| Running sidebar list | `runningProjects`: filter **already-loaded** `project.sessions` by those ids | **Intersection with pagination** |
| Chat header dropdown | `SessionSwitcher` → `getAllSessions(project)` | Current project’s **loaded** sessions only; **not** running-aware |

`AppContent.refreshRunningSessions` polls every 5s and on `running_sessions_changed`, then `syncProcessingSessions`. Chat composer / ActivityIndicator read the same map.

---

## Bug classes (why “2” vs one dropdown row)

### 1. Global count vs project-scoped switcher (primary UX bug)

The badge counts **all** processing sessions in the app (any project, chat or shell).

`SessionSwitcher` only renders `project.sessions` for the **selected** project.

The second “running” session can be:

- Another project (PERSONAL has 8 projects; EYEWA is also in the screenshot).
- A session in CloudCLI Fork that is **not in the loaded page** (501 sessions; first page is a small slice).
- A session the user is not viewing, so they expect the dropdown to *be* the running list.

**Fix direction:** Either (a) make the badge/list/switcher all consume one `runningSessions: Session[]` from the API (include title, project, provider), or (b) change the header dropdown while `runningCount > 0` to a “live sessions” list (global), with a separate “all sessions in this project” search.

### 2. Pagination hole (badge 2, running sidebar also empty/partial)

```ts
// useSidebarController
const sessions = (project.sessions ?? []).filter((session) =>
  activeSessionIds.has(String(session.id)),
);
```

If the live `sessionId` is not in the in-memory page, **Running now shows nothing for it** while the badge still increments.

CloudCLI Fork with 501 sessions makes this likely.

**Fix direction:** `/sessions/running` must return enough fields to **render rows without joining the paginated project list**. Running view should render that payload, not `filter(project.sessions)`.

### 3. Ghost ids in the client map

`syncProcessingSessions` keeps **chat** activity for `LOCAL_ACTIVITY_GRACE_MS` (10s) after the server omits it. Combined with:

- optimistic `markSessionProcessing` on send,
- stale `chat.subscribe` idle-ack guards,
- a session that never lands in `project.sessions` (create race, internal row visibility, failed upsert),

the map size can be **2** while only **1** session exists in UI lists.

Shell idle is already server-authoritative (no grace). Chat still has the grace window.

**Fix direction:** Grace may stay for *composer spinner on the session you just sent*, but it must not increment the **global badge** unless the session is in the server snapshot **or** is the locally viewed session with an in-flight send.

### 4. Chat vs Shell still not the same session identity

`listRunningSessions` de-dupes shell when the same `sessionId` is already a chat run. Remaining failure modes:

- Chat run id ≠ Shell PTY’s `sessionId` (plain shell, missing `sessionId` on init, provider-native id vs app id).
- Two PTYs / reconnect keys for one conversation (`shellSessionRegistry` is keyed by **PTY key**, listed by **sessionId**; duplicate keys with different ids inflate count).
- TUI classifier false positives (`thinking` in scrollback, `working` in transcript) re-registering an idle shell as busy.
- TUI classifier false negatives (busy without interrupt chrome) so Chat shows idle while a turn is live — the original report; inverse of this ticket.

**Fix direction:** One `SessionActivity` record per **app session id**. Chat run OR TUI busy ⇒ running. Registry keyed by app session id, PTY key is an implementation detail.

### 5. Internal / swarm / automation sessions

`listRunningSessions` **includes** `is_internal` rows so swarm work shows in the sidebar. `canInterrupt` is false for those.

If internals are **hidden** from `SessionSwitcher` / default project session lists but **included** in the running API, badge > visible list.

**Fix direction:** Same visibility rule everywhere. If internals are listed in the project sidebar they belong in the switcher and running list. If not, they must not count.

### 6. Switcher is the wrong control for the job

Even with perfect data, `SessionSwitcher` is a **project session picker** (search, archive, delete). It does not:

- filter or pin running sessions,
- show a spinner / “live” row,
- include other projects,
- fetch beyond the current page (`hasMore` / `onLoadMoreSessions` exists but is not auto-used to find the other live id).

Users who click the chat title after seeing “2” will keep reporting this as a bug.

---

## Reproduction notes for the next agent

1. Open CloudCLI Fork (large session count).
2. Start a Chat turn in session A.
3. In another session **or** another project **or** Shell tab, start work so `/sessions/running` has two ids.
4. Open the chat header chevron (session switcher).
5. Compare:
   - `GET /api/providers/sessions/running`
   - rail badge
   - sidebar **Running now** (activity icon)
   - switcher rows
   - composer spinner on the viewed session

Expected after fix: all four agree.

Also re-test the original idle-TUI case: Grok/Claude sitting at `>` with shortcut chrome must **not** keep the badge.

---

## Suggested implementation plan (do not partial-fix)

1. **API:** Expand `listRunningSessions` to return `{ sessionId, projectId, title, provider, source, startedAt, canInterrupt, statusText }` for every live id. No pagination.
2. **Client:** Store that array as the only running state. Derive `Map` for `isProcessing` checks. **Stop** using `activeSessions.size` independently of the array length.
3. **Running sidebar:** Render the API array grouped by project; do not intersect with `project.sessions`.
4. **Session switcher:** While any sessions are running, pin those rows at the top (even other projects / not in current page). Label source Chat vs Shell.
5. **Shell classifier:** Keep busy/idle on TUI frames; register/unregister **app session id** only.
6. **Tests:**  
   - two live sessions, only one in current project page → badge 2, running list 2, switcher shows both pinned.  
   - idle TUI → 0.  
   - chat grace does not create a phantom second badge.  
   - internal swarm: either visible in all three surfaces or in none.

---

## Files to read first

- `src/hooks/useSessionProtection.ts`
- `src/components/app/AppContent.tsx` (`refreshRunningSessions`)
- `src/components/sidebar/hooks/useSidebarController.ts` (`runningSessionsCount`, `runningProjects`)
- `src/components/main-content/view/subcomponents/SessionSwitcher.tsx`
- `server/modules/providers/services/sessions.service.ts` (`listRunningSessions`)
- `server/modules/websocket/services/shell-session-registry.service.ts`
- `server/modules/websocket/services/shell-tui-activity.ts`
- `server/modules/websocket/services/shell-websocket.service.ts` (register/unregister on classify)
- `server/modules/websocket/services/chat-run-registry.service.ts`

---

## Out of scope / already attempted

- Treating “PTY connected” as running (reverted conceptually; classifier exists).
- 5s poll only (WS `running_sessions_changed` already exists; it does not fix mismatched consumers).
