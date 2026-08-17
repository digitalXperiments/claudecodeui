# PRD: Provider Usage Legend Bar

**Status:** Draft — implementation not started  
**Product:** CloudCLI Fork  
**Date:** 2026-08-15  
**Audience:** Swarm / implementation agents  
**Inspiration:** CodexBar (macOS menu-bar popover: per-provider tabs, remaining quota bar, reset countdown, refresh)

---

## 0. Intent

Operators run several vendor CLIs from one CloudCLI UI. Each vendor account has **its own** hourly / weekly / credit-period limits. Today those limits are invisible until a run 429s.

Build a **persistent live legend** on the **right edge of the chat canvas** that lists every **signed-in** provider and shows remaining vendor-account quota. Auto-refresh every **5 minutes**. Include a **manual refresh** control.

**Do not confuse this with `LiveSpendMeter`.** That meter is session USD vs CloudCLI soft/hard spend caps (`/api/runs/live-usage`, `/api/features`). This bar is **vendor-account quota**, not CloudCLI session spend.

---

## 1. Problem

- Rate limits and plan credits are **per vendor account**, not per CloudCLI session.
- Operators discover limits only when a run fails (`429`, “rate limit”, “quota”).
- Multi-provider workflows (Claude + Grok + Codex in one canvas) have no single place to see remaining headroom.
- CodexBar already solved this as a desktop popover; CloudCLI needs the same information **inside the product**, next to the chat they are actually running.

---

## 2. Goals

| ID | Goal |
| --- | --- |
| G1 | Show remaining hourly and/or weekly (or equivalent credit-period) quota for every **logged-in** provider. |
| G2 | Persist on the chat canvas (right edge), always glanceable without opening Settings. |
| G3 | Poll every **5 minutes** without hammering vendor APIs. |
| G4 | Manual refresh button that re-fetches immediately and shows last-updated time. |
| G5 | Degrade gracefully when a provider has no public usage API or the user is logged out. |
| G6 | Stay visually distinct from `LiveSpendMeter` (session $) so operators do not mix the two. |

### Non-goals

- Not a replacement for CloudCLI spend governor / `LiveSpendMeter`.
- Not a billing dashboard (no invoices, payment methods, plan upgrades).
- Not a global menu-bar / OS tray app (CodexBar already exists).
- Do not scrape undocumented HTML dashboards if a vendor ToS or auth surface forbids it.
- Do not invent fake remaining-percent numbers when the provider did not return them.

---

## 3. Users & context

**Primary user:** operator running CloudCLI locally, signed into one or more of Claude, Grok, Codex (and later Cursor / others).

**When they look:** mid-session, before kicking a long swarm or Mission Control job, after a 429, when deciding which provider to use next.

**Placement (user sketch):** floating / docked legend on the **right edge of the chat canvas**, listing providers as compact rows (`claude` / `grok` / `codex`, …).

---

## 4. Inspiration — CodexBar (what to copy)

From the referenced CodexBar popover:

- Provider identity + plan name (e.g. “ChatGPT Plus”).
- Primary remaining bar (used / limit, percent remaining).
- Reset countdown (“resets in 5d 3h”).
- Secondary windows if the vendor has more than one (5h window vs weekly).
- Credits remaining when the vendor is credit-based (not just %).
- Last updated timestamp + refresh affordance.
- Tabs or rows per provider the user is authenticated with.

CloudCLI should feel like that **information density**, but as a **narrow vertical legend** (right rail), not a macOS popover.

---

## 5. Product requirements

### 5.1 Visibility & membership

- Show only providers the user is **currently logged into** (same source of truth as existing auth-health / provider login status).
- If zero providers are logged in, hide the bar entirely (or show a single collapsed “not signed in” chip — prefer hide).
- If a provider logs out, drop it on the next refresh.
- If a provider logs in, add it on the next refresh (or immediately after the login success event if that event already exists).

### 5.2 What each row shows

Minimum for each signed-in provider:

1. **Provider id / mark** — existing CloudCLI provider branding (icon + short name).
2. **Primary window** — the most operationally useful limit:
   - hourly / 5-hour window if the vendor uses rolling short windows (Codex-style);
   - weekly if that is the only published window;
   - credit balance if the vendor is credit-based.
3. **Remaining** — percent remaining **or** remaining/limit counts, never a fake 100%.
4. **Reset / refill** — human countdown if the vendor supplies a reset timestamp.
5. **Stale / error state** — “unavailable”, “logged out”, or last-known + “stale” if fetch failed.

Optional (if vendor payload includes them, do not invent):

- Plan name (Plus / Pro / Max / Team).
- Secondary window (e.g. weekly under an hourly bar).
- Credits remaining + credit-period end.
- Rate-limit “retry after” if the last run hit 429 for that provider.

### 5.3 Refresh

| Trigger | Behavior |
| --- | --- |
| Mount | Fetch once. |
| Interval | Every **5 minutes** while the chat canvas is mounted (and optionally while the window is focused — see 7.4). |
| Manual | Refresh control on the legend; disables / spins until the fetch settles; then updates “Updated Xs ago”. |
| Auth change | Re-fetch after login/logout of any provider. |

- Manual refresh must not bypass vendor-side rate limits: if the last successful fetch was < **15 seconds** ago, reuse cache and toast/tooltip “just updated”.
- Show **last successful fetch** time even if a later fetch failed.

### 5.4 Interaction

- Default: compact stacked rows, non-blocking, does not steal chat scroll or composer focus.
- Hover / click a row: expand that provider to show secondary windows + last error (popover or inline expand). Keep the default state thin.
- Collapse control: remember collapsed vs expanded in local preference (`localStorage` or existing settings store).
- Do **not** navigate away from chat on click.

### 5.5 Visual distinction from spend meter

- `LiveSpendMeter` stays where it is (session $).
- Legend uses **quota language**: “remaining”, “resets”, “credits” — never “spent $” unless the vendor literally returns USD remaining.
- If both are visible, they must not occupy the same corner.

---

## 6. Provider coverage (v1)

Implement behind a per-provider **adapter**. v1 adapters:

| Provider | Expected windows | Data source (investigate; do not invent) |
| --- | --- | --- |
| **Claude** | Session / 5h and weekly (Claude Code / Anthropic usage) | Existing Claude CLI / SDK usage endpoints already used by CloudCLI if any; else official usage API the logged-in CLI can call. |
| **Codex / ChatGPT** | 5h window + weekly + credits (CodexBar-shaped) | Same family of usage payload CodexBar reads; reuse if CloudCLI already shells `codex` with an authenticated session. |
| **Grok** | Whatever xAI / Grok CLI actually exposes (rate window or credits) | Grok CLI / xAI usage if present; otherwise “signed in · usage N/A”. |

Later (explicitly out of v1 unless an adapter is already trivial):

- Cursor
- Gemini / other providers already listed in CloudCLI auth

**Rule:** if an adapter cannot obtain a real remaining value, the row still appears when the user is logged in, with `usage: unavailable` — never a guessed bar.

---

## 7. Technical design (guidance for implementers)

### 7.1 Backend

Add a dedicated module, e.g. `server/modules/provider-usage/`:

- `GET /api/provider-usage` → `{ fetchedAt, providers: ProviderUsage[] }`
- Optional `POST /api/provider-usage/refresh` if server-side cache must be busted; otherwise `GET` with `Cache-Control` + short TTL is enough.

Server owns:

- Auth detection (which providers are logged in).
- Per-provider adapters.
- **In-memory cache** with TTL **5 minutes** (align with UI poll).
- Manual refresh: `?fresh=1` or `Cache-Control: no-cache` that bypasses TTL but still respects the 15s anti-stampede.

Do **not** put vendor credentials in the browser. The browser only sees aggregated, already-authenticated results.

### 7.2 Suggested payload

```ts
type UsageWindow = {
  id: string;                 // 'hourly' | 'five_hour' | 'weekly' | 'credits' | string
  label: string;              // '5h window' | 'Weekly' | 'Credits'
  used: number | null;
  limit: number | null;
  remaining: number | null;
  remainingRatio: number | null; // 0–1, null if unknown
  resetsAt: string | null;    // ISO
  unit: 'tokens' | 'requests' | 'credits' | 'percent' | 'unknown';
};

type ProviderUsage = {
  providerId: string;         // 'claude' | 'grok' | 'codex' | …
  displayName: string;
  signedIn: boolean;
  planName: string | null;
  primaryWindowId: string | null;
  windows: UsageWindow[];
  status: 'ok' | 'unavailable' | 'error' | 'stale';
  error: string | null;
  fetchedAt: string | null;
};
```

### 7.3 Frontend

- New component, e.g. `src/components/chat/view/subcomponents/ProviderUsageLegend.tsx`.
- Mount from `ChatInterface` on the **right edge of the chat canvas** (absolute / sticky), not inside the sidebar.
- Hook: `useProviderUsage({ intervalMs: 5 * 60_000 })` using `authenticatedFetch`.
- Manual refresh button + relative “Updated …” clock.
- Empty/hidden when `providers.filter(p => p.signedIn).length === 0`.

### 7.4 Performance & politeness

- One HTTP call from the UI, N adapters on the server.
- Server cache shared across tabs/windows.
- Pause polling when `document.hidden` (Page Visibility); resume on focus with cache-if-fresh.
- Never poll faster than 5 minutes except manual refresh.

### 7.5 Failure modes

| Case | UI |
| --- | --- |
| Provider logged in, adapter throws | Row + `error` / last known windows marked stale |
| Provider logged out | Omit row |
| All adapters fail | Bar stays, each row error; refresh still enabled |
| User not authenticated to CloudCLI | Existing app auth handling; no extra leak |

### 7.6 Tests

- Adapter unit tests with **recorded fixtures** (no live vendor calls in CI).
- Route test: signed-in vs signed-out membership.
- Cache test: second GET within TTL does not re-hit adapters; `fresh=1` does.
- Frontend: render remaining %, countdown, unavailable, empty-hide.

---

## 8. UX spec (compact)

**Default rail (approx. 160–200px, right of messages):**

```
┌─────────────────────┐
│ Usage          ↻    │
│ updated 2m ago      │
│                     │
│ ◆ claude            │
│ ████████░░  72%     │
│ weekly · 4d 2h      │
│                     │
│ ◆ grok              │
│ usage n/a           │
│ signed in           │
│                     │
│ ◆ codex             │
│ ██████░░░░  61%     │
│ 5h · 3h 12m         │
└─────────────────────┘
```

- `↻` is the manual refresh.
- Bar color: healthy → warning (<25% remaining) → critical (<10% or vendor-reported exhausted).
- Use existing design tokens / `index.css`; match CloudCLI density, not a third-party macOS chrome.

**Expanded row:** plan name, all windows, raw used/limit, last error.

**Collapsed:** icon + mini bar or percent only (user preference).

---

## 9. Settings

- Toggle: **Show provider usage legend** (default **on** if any provider signed in).
- Optional: poll interval is **fixed at 5 minutes** in v1 (no user-tunable interval — avoids accidental API abuse).
- Persist collapsed state.

Do not add a new Settings tab unless the existing Appearance / providers settings have no home for a single checkbox.

---

## 10. Analytics / events (optional)

If CloudCLI already has client telemetry:

- `provider_usage_legend_shown`
- `provider_usage_manual_refresh`
- `provider_usage_row_expand`

No PII; no raw vendor tokens.

---

## 11. Success metrics

- Operator can answer “can I start another long Claude / Codex / Grok job?” without leaving chat.
- 429s that were surprises drop after operators start using the bar (qualitative).
- Manual refresh works in < 2s when cache is warm, < vendor RTT when cold.
- Zero fake percentages in production (unavailable is allowed; guessed 100% is not).

---

## 12. Rollout

1. **PR1 — contract + stub adapters + API + cache.** UI can render fixtures.
2. **PR2 — real adapters** for Claude and Codex (highest CodexBar parity).
3. **PR3 — Grok adapter** + legend UI on chat canvas + refresh + 5 min poll.
4. **PR4 — polish:** collapse preference, warning colors, visibility-aware polling, tests.

Ship the bar hidden behind the settings toggle until at least one adapter returns real windows.

---

## 13. Open questions (resolve during implementation, do not block the PRD)

1. Does Claude Code already expose a usage JSON we can exec locally (same as model list)?
2. Does Codex CLI expose the same payload CodexBar uses, or must we call an OpenAI usage endpoint with the logged-in session?
3. Does Grok / xAI expose any remaining-quota field today? If not, v1 row is “signed in · usage n/a”.
4. Should Mission Control / Swarm views also show the legend, or chat-only in v1? **Recommendation: chat-only for v1.**
5. Multi-account per provider (two Claude orgs)? **v1: the currently active CLI account only.**

---

## 14. Acceptance criteria

- [ ] Logged-in providers appear; logged-out providers do not.
- [ ] At least one adapter shows a real remaining window or credits when the vendor supports it.
- [ ] Auto-refresh every 5 minutes while chat is mounted and the tab is visible.
- [ ] Manual refresh re-fetches, respects 15s anti-stampede, updates “last updated”.
- [ ] Failed fetch does not blank a previously good row (stale + error).
- [ ] `LiveSpendMeter` still works and is visually separate.
- [ ] No vendor credentials or raw cookies in network responses to the browser.
- [ ] CI tests for cache, membership, and fixture-backed adapters.
- [ ] Unavailable providers never show a fabricated 100% bar.

---

## 15. Implementation notes for swarm agents

- Read this file first. Do not “also redesign” spend governor or `LiveSpendMeter`.
- Prefer extending existing provider modules (`server/modules/providers/`) over a one-off script in `claude-sdk.js`.
- All temp / recorded fixtures go under `tmp/cloudcli/provider-usage/` then checked-in fixtures under the module `tests/fixtures/`.
- Verify UI in the browser: chat with 0, 1, and 3 signed-in providers; refresh; hide tab and confirm poll pause if implemented.
- Update project memory (`Projects/CloudCLI/Entities/`) when adapters’ real endpoints are discovered.

---

## 16. Related surfaces (do not reuse blindly)

| Surface | Role |
| --- | --- |
| `src/components/chat/view/subcomponents/LiveSpendMeter.tsx` | Session USD vs CloudCLI caps |
| `server/modules/runs/spend-governor.service.ts` | Soft/hard CloudCLI spend |
| `server/modules/auth-health/` | Hourly auth probes — membership signal, not quota |
| `server/modules/failover/` | Classifies `rate_limit` after the fact |

The legend is **proactive remaining quota**. Failover and spend governor stay as they are.
