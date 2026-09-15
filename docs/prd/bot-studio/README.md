# Bot Studio — Action Centre grown up

**Date:** 2026-09-15 · **Status:** brainstorm + clickable prototype · **Owner:** Ram

Open `prototype.html` in any browser (no build, no server). Hash routes work, so you
can deep-link: `#/inbox`, `#/bots/work-gmail/tools`, `#/new/3`, `#/templates`,
`#/activity`, `#/import`. Press the 💡 button in the header for per-screen design
notes; press `⌘K` for the palette; `J/K/A/D/R/Space` work in the Inbox.

Screenshots: `shots/inbox.jpg`, `shots/tools.jpg`, `shots/architect.jpg`.

---

## 1. The decision

| Discard | Keep and grow |
|---|---|
| `src/components/bots/*` (the standalone Bot Studio modal) | `server/modules/bots/` data model (versions, ticks, proposals, graders) |
| `src/components/integrations/*` + `server/modules/integrations/` (Integration Center) | MCP catalog (`~/.cloudcli/mcp/catalog.json`) as the **only** capability layer |
| Mission Control panel as a modal with a section editor | Mission Control's produce → item → action loop, seeds, x_article contract, import |

The **Action Centre becomes Bot Studio**. One noun, **Bot**, one full-page surface.
Every action a bot takes is an MCP tool call under a per-tool policy. No bespoke
integration adapters, no OAuth screens inside Bot Studio: accounts are connected once
in the MCP catalog and picked per bot.

This matches the Endurance PRD §5.2.2 / D11 / D12 and the 2026-09-07 `bot-studio`
decision's design constraints (reuse the run spine, fresh run per tick, propose-only
by default, heterogeneous roster, shadow versions, kill switch).

## 2. Why the current Action Centre feels clumsy

From the code audit (`MissionControlPanel.tsx`, 2,126 lines):

1. **It is a modal inside the sidebar tree**, not a route. It fights the chat view
   for space and cannot host a second pane (no "talk to the bot", no live transcript).
2. **Create / edit section is one long form** rendered as an overlay *inside* the
   modal: 20+ fields in a single scroll (title, scope, mode, project, provider, model,
   cron, produce prompt, produce MCPs, resolve prompt, resolve MCPs, Kanban toggle plus
   three more fields, permission mode, four checkboxes). Three separate MCP
   multiselects (produce / resolve / kanban) for what is really one policy.
3. **Section Architect and starters only exist in create mode**, so an existing
   section can never be improved conversationally.
4. **No per-bot identity**: a section is a cron that fires a prompt. There is no
   agent escalation, no memory view, no versions, no health, no simulate.
5. **The queue is per section** ("All" is a flat list) with "Needs attention / All
   history" tabs; there is no cross-bot activity feed and no keyboard flow.

## 3. Information architecture

```
Bot Studio (route /bots, full main-content area, like /studio)
├─ Header: Inbox · Bots · Templates · Activity | ⌘K | spend today | kill switch | + New bot
├─ Left rail (280px, collapsible): Inbox / Activity / Templates / Import
│     Roster grouped: Needs me · Healthy · Paused · Failing
│     row = icon, name, mode chip, next tick, pending count, grade sparkline
├─ Centre (fluid)
│     Inbox        unified item queue, filters, batch bar, keyboard
│     Bot detail   header (mode segmented control, enabled, Run now, Simulate, Talk)
│                  tabs: Overview · Inbox · Brief · Tools · Triggers · Outputs & actions
│                        · Memory · Ticks · Versions · Health
│     Architect    8-step wizard replacing the form (see §5)
│     Templates    six legacy seeds + eight bot templates
│     Activity     live cross-bot tick feed
│     Import       migration report (legacy sections → bots)
└─ Right pane (400px, collapsible): context for whatever is selected
      Inbox item   why / source (untrusted box) / draft / steering note / preview / actions / timeline
      Bot          Talk to bot  ⇄  Tick transcript (live when running)
      Architect    live bot-card preview + Architect chat that drafts the brief
```

Layout skeleton is Design Studio's: `grid-template-columns: rail | 1px | 1fr | 1px |
context`, CSS var driven, both side panes collapsible and (in the real build) drag
resizable exactly like `StudioView.tsx:447-465`.

## 4. The Bot model the UI is built on

Identity · Agent (+ escalation agent) · Brief (start / steps / done, versioned) · Tools
(MCP servers with per-tool allow / ask / deny, skills, own browser session) · Memory
(distilled vs episodic, promotion rules) · Triggers (cron, webhook, run_completed,
kanban_event, interrupt_created, ask_bot, file_changed, manual, quiet hours, overlap
policy) · Outputs (inbox_item, proposal, kanban_card, swarm, session, notification,
x_article) · Action set (label, kind, terminal, hold-for-approval, handler prompt) ·
Autonomy (dry_run / propose / act) · Guardrails (daily + monthly budget, hop limit, max
items per tick, dry-run first N ticks after a brief change) · Graders · Versions (score
curve, diff, restore, shadow) · Health.

Mapping from today's `mc_sections`: `produce_prompt → brief.steps`, `resolve_prompt →
action handler prompts`, `produce_tools + resolve_tools + kanban_mcp_tools → one policy
grid`, `review → propose`, `fire_and_forget → act`, `auto_approve → act with the
approve action not held`, `dry_run → dry_run mode`.

## 5. Bot Architect (replaces create / edit section)

| Step | What you decide | What the Architect does for you |
|---|---|---|
| 1 Purpose | name, one-sentence purpose, scope, tags, "good looks like" | — |
| 2 Agent | provider, model, effort, permission mode, escalation agent, or an agent profile | suggests a cheap / strong pair |
| 3 Brief | start / steps / done | drafts all three from the purpose (`POST /api/bots/draft`), regenerates with a note |
| 4 Tools | MCP servers + per-tool policy, skills, browser, memory scope | recommends servers, applies a read-only preset |
| 5 Triggers | any combination, cron string, quiet hours, overlap | — |
| 6 Outputs & actions | which outputs, the action set, live item preview | suggests actions from the brief |
| 7 Guardrails | budgets, max items, dry-run-first-N, hop limit, graders | turns "good looks like" into graders |
| 8 Review & dry run | summary + a simulated tick against a time window | runs the dry tick, shows what would be emitted |

Every step is skippable and revisitable. The same flow is entered from **Templates**,
**fork a bot**, and **turn this chat into a bot**. Editing an existing bot never opens a
form: each tab edits in place and creates a new version with a change reason.

## 6. Where it beats Grok Bot

| Grok Bot | Bot Studio |
|---|---|
| One model family | Any of 12 provider CLIs per bot, plus an escalation agent per bot |
| Long-lived session | Fresh run per tick, memory as continuity, versions and grades per tick |
| Opaque decisions | Talk to the bot, tick transcript, "why did you…" answers that become proposals |
| Trust the bot or don't | Per-tool allow / ask / deny, held actions, simulate before Act, kill switch, budgets |
| Bots do not improve measurably | Score curve by version, shadow mode with auto-promote threshold, human-review grader built in |
| Cloud VM only | Local Mac, headless Mac or cloud, Obsidian memory you own |

## 7. Implementation notes (for the build PR, not done here)

1. **Route**: add `/bots` next to `/studio` in `src/App.tsx`; `useProjectsState` gets
   `botsActive` / `enterBots` / `leaveBots` mirroring the studio pair;
   `MainContent.tsx` early-returns `<BotStudioView>` the same way it does StudioView.
   Sidebar rail: one button "Bot Studio" replaces the two current ones (Bots, Action Centre).
2. **Data**: server E1.13 from the Endurance PRD (bot_items from mc_items, bot_templates,
   bot_triggers, action set on the bot, per-tool MCP policy E1.14). Until it lands, the
   web client can adapt `/api/mission-control/*` + `/api/bots/*` behind one hook.
3. **Delete**: `src/components/bots/`, `src/components/integrations/`,
   `server/modules/integrations/` (after MCP catalog covers Gmail / Slack / Trello via
   claude.ai connectors or Composio), `MissionControlPanel.tsx` once the alias period ends.
4. **Keep**: `article-studio*`, `article-assets*`, seeds (as templates), legacy import.
5. **Events**: `bot_item_created / updated`, `bot_tick_updated`, `bot_proposal_created`
   drive the live rail counts, the running strip and the transcript pane.

## 8. Open questions for Ram

- Should Automation recipes also fold into Bots now, or stay as stateless glue (PRD keeps them separate)?
- Per-bot browser session: isolated Chrome profile per bot, or one shared profile with per-bot tabs?
- Do we want the Needs You badge to count bot inbox items (PRD says yes) or keep it for interrupts only?
