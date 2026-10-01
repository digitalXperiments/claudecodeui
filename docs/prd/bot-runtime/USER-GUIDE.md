# Bot Studio, the friendly guide

Your bots are like small assistants that live on your always-on Mac. Each one has a job ("summarise
my Jira tickets", "triage my Gmail"). They wake up when something happens, do their job, and come
back to you when they need a decision. This guide walks through every screen, without the jargon.

> Everything here needs **Settings → Appearance → Bot runtime v2** switched on. Switch it off and
> Bot Studio goes back to how it was before.

---

## The big picture in four ideas

1. **A bot wakes up for a reason.** It could be the clock ("every weekday at 9"), something arriving
   (a new email, a webhook from another app, a new item in an RSS feed), or you sending it a message.
2. **A bot asks before doing anything risky.** Reading and drafting are fine. By default, sending,
   publishing, deleting, buying, touching passwords or changing a live system ask you first. You
   choose how far each bot may go on its own (see *Abilities* and *How permissions work* below).
3. **A bot gets better from your feedback.** When you approve, dismiss or send back its work, it
   suggests lessons ("ignore newsletters from X"). Nothing changes until you approve the lesson.
4. **A bot can reach you anywhere.** In the app, as a phone notification, in Slack or Telegram, with
   Approve and Deny buttons you can tap.

---

## Fleet-wide screens (left menu)

### Overview (Command Center)
Your control room. The **Runtime** row at the top tells you at a glance:
- **Runtime**: *Running* means bots can wake up. *Forced off* means the server was started in a safe
  test mode and bots won't wake.
- **Queued events**: things that have arrived but a bot hasn't looked at yet.
- **Active episodes**: bots working right now. (An *episode* is one wake-up of one bot.)
- **Gate asks**: actions waiting for your OK.
- **Cost today**: what your bots have spent on AI today.
- **Tainted 24h**: wake-ups where a bot read outside content, such as an email or a web page. Those
  wake-ups are extra careful: risky actions always come to you.

Below that is the familiar list of bots that need attention, recent activity and the fleet.

### Inbox and Board
These work as before. *Inbox* holds bot suggestions waiting for your decision. *Board* shows the
same work as columns (waiting → ready → in progress → in QA → done).

### Brief
Your **morning newspaper** about the bots. Pick *Last 24h / 3 days / 7 days* and you'll see:
- what each bot did, with failing bots at the top;
- what is waiting for you (approvals, work to check, actions waiting for an OK);
- follow-ups due soon;
- lessons the bots want you to approve;
- what each bot cost;
- notifications that were held back during your quiet hours.

**Send brief now** pushes it to your channels. You can also have it arrive automatically every
morning (set the time on a global channel in *Channels*).

### Channels
Where your bots can reach you.
- **In-app** is always on. Nothing is ever lost.
- **Web push** sends notifications to browsers where you've allowed them.
- **Slack**: paste the *name* of a secret that holds the bot token (or an incoming-webhook URL),
  plus the channel ID. Messages come with Approve / Deny buttons.
- **Telegram**: secret name for the bot token, plus your chat ID. Turn on *Read my replies* and you
  can talk to your bots from Telegram. Only your chat ID is listened to.
- **Email** isn't available as a channel yet (see the note at the end).

Each channel has **quiet hours** (nothing goes out then unless it's urgent), a **daily limit**, a
**minimum urgency**, and **digest only** (save everything for the brief). **Send test** checks that
it works. The **outbound log** at the bottom shows everything that was sent or held back, and why.

For the buttons to work from your phone, CloudCLI needs to know its public address (your tunnel
URL). It's shown under *Public base URL*.

### Teams
Group up to 6 bots that work toward one goal, for example *Triage → PR shepherd → Changelog*.
- Give the team a name and goal, add bots with a role, and pick a **coordinator** (the bot that
  runs the show).
- **Wake team** sends a note to the coordinator, who can ask the others for help or hand them work.
- **Spaces** are living documents a bot keeps up to date, like a weekly report. You can read and
  edit them here, but it's easier on the bot itself: **Manage in the bot's Abilities tab**.
- **Peer traffic** shows who asked whom for what.

---

## One bot's screens (click a bot → the tabs along the top)

### Overview
Same as before: counts, the brief, the latest wake-ups and items.

### Abilities
**Everything this bot can do, and where to give it more.** One page, five sections, plain language.
A bot starts with almost nothing: it can only use the apps, skills, notes and logins you give it here.

1. **How much it can do alone.** Pick one of three levels (details in *How permissions work* below):
   - **Careful** (the default): reads, drafts and works in its own folder. Asks you before sending,
     publishing, deleting, buying or working outside its folder.
   - **Trusted**: also sends, publishes, deletes and works outside its folder on its own. It still
     asks right after it has read outside content (emails, web pages), and it never touches your
     passwords or login files.
   - **Unrestricted**: no gate at all. Only for bots you fully trust that read nothing from outside.
     Because it's risky, you have to type the word *unrestricted* to switch it on.

   Underneath you'll see three plain lists for this bot right now: **Can do alone**, **Asks you
   first** and **Never does**, plus a line like "Claude is fully controlled by the gate".
2. **Apps it can use.** The apps (Gmail, Slack, Jira…) attached to this bot, whether each is
   connected, and how many of its tools are allowed, ask first or blocked. A bot can only use the
   apps listed here. **Change apps** lets you add or remove apps and set each tool to allow, ask or
   block, without leaving the page.
3. **Skills.** Short how-to playbooks the bot follows. Create one, edit it, switch it on or off,
   build one from a past run, or link one from your catalog. **Teach by showing** records a browser
   task once and drafts a skill from it (switched off until you review it). New skills start off.
4. **Spaces.** Shared notes files that you and the bot can both read and write: create, open, edit
   and delete them right here.
5. **Accounts & logins.** The bot's own keys for its apps (stored encrypted, never shown again) and
   its own browser:
   - **Sign in as this bot**: type a website address, press the button, and the bot's browser opens.
     You do the typing (the bot never sees your password), then press **I'm done signing in**.
   - **Sign the bot out everywhere** deletes the bot's browser logins (it asks you to confirm).
   - A bot can't be signed in or out while it's running. If you see "this bot is running right
     now, or its browser is in use", wait for it to finish or pause it, then try again.

The **Rules** and **Learning** tabs are still there, and now point you back here: skills and
credentials are managed on Abilities only, so there is never two places to edit the same thing.

### Activity
The bot's **diary**. Every wake-up is a row: why it woke (*Scheduled*, *Webhook*, *You*), whether it
worked, how long it took, what it cost, and a shield badge if it read outside content.
Click a row to see:
- **Plan and summary**: what it intended and what it says it did.
- **Outcome**: items it created, follow-ups it set, goal updates, and its reply to you.
- **Events**: exactly what woke it.
- **Gate decisions**: every action it tried, and whether it was allowed, asked or blocked.
- **Runs**: the step-by-step timeline of the AI's work.

**Wake now** (optionally with a note) gets it going immediately.

### Thread
**Chat with the bot.** Ask "what are you working on?" or say "stop emailing Sam". Sending a message
wakes the bot, and its reply appears here (and in Slack/Telegram if you messaged it from there).
Instructions you give here can become lessons in *Learning*.

### Goals
What the bot is **working toward**, not just what it does each time.
- **Goals**: a statement ("Keep every Jira ticket summarised within a day"), how you'll know it's
  done, a progress bar and the bot's latest note. Notes marked *untrusted* were written after the
  bot read outside content, so take them with a pinch of salt.
- **Commitments**: follow-ups the bot promised itself ("check on the vendor reply Thursday"). It
  wakes up on its own when one is due. You can complete, cancel or add your own.

### Triggers
**What wakes this bot up.** Add as many as you like:
- **Schedule**: the familiar presets, or type it in plain English ("weekdays at 9 except Fridays")
  and see what it understood.
- **Webhook**: another app can poke the bot through a private, signed web address shown on the card.
- **Watch**: keep an eye on an RSS feed, a folder, a GitHub repo or a web address that returns data.
  The bot wakes only when something actually changes, so watching is cheap.
- **When something happens in CloudCLI**: a run finishes, a Kanban task finishes, or something new
  lands in "Needs you".

If lots of things arrive at once, the bot waits a few seconds and handles them in one go (the
*coalesce* window). **Test fire** sends a pretend event, and **Recent events** shows what arrived.

### Rules
**Fine-tune single actions, and what the bot may spend.** (How much it may do alone, its apps and
its logins are on **Abilities**.)
- **Enforcement** shows how strictly the gate controls this bot. *Enforced* means every tool call
  and built-in action goes through the gate.
- **Safety floor**: for a *Careful* bot, the six risky kinds of action (send, publish, delete,
  purchase, credentials, production changes) always ask you, unless you add an explicit rule for
  this one bot.
- **Rules**: "always allow X", "always ask before Y", "never do Z". Type a tool name and the screen
  tells you how risky it is. Clicking *Always allow* on an approval card creates one of these for
  you, and it expires after 30 days.
- **Gate decisions**: the full log of what was allowed, asked and blocked, and why.
- **Budget**: daily and monthly dollar limits, a daily action limit and a wake-ups-per-hour limit,
  with meters. At 80% the bot switches to a cheaper model. At 100% it stops until tomorrow.
- **Credentials** moved to **Abilities → Accounts & logins**.
- **Failover**: if the main AI provider is down or rate-limited, try these others, in order. It
  never retries after the bot has already done something like sending, so nothing happens twice.

### Learning
**What the bot has learned, and what it wants to learn.**
- **Proposals**: lessons suggested from your feedback, such as a memory ("ignore Medium digests"),
  a rule ("you approved this 5 times, allow it?") or a skill ("save this as a playbook"). Approve
  (you can edit first) or reject. Nothing applies until you approve.
- **Skills** now live on **Abilities → Skills** (this tab links there).
- **Teach mode**: show the bot a browser task once. It records your clicks (never passwords) and
  drafts a skill from them, switched off until you review it. When it's saved, you're taken to the
  skill on the Abilities tab.
- **Preferences**: facts about *you* that every bot reads (shared across bots).
- **Privacy**: download everything the bot knows, or wipe selected parts.

### Pipeline, Test, History, Settings
Unchanged: the bot's instructions and tools, a dry-run simulator, past runs and versions, trust and
memory settings, and delete.

---

## How permissions work
Think of three layers, from the outside in. A bot has to get past all of them.

1. **Apps: can it touch this at all?** A bot can only use the apps attached to it (Abilities →
   Apps). If Gmail isn't there, the bot can't read your mail, whatever you ask. For each app you can
   also allow, ask first, or block individual tools.
2. **Autonomy and rules: does it have to ask first?** This is the **gate**. It checks every action
   the bot is about to take. Your **autonomy** level sets the general posture (Careful asks before
   risky things; Trusted asks far less), and **rules** on the Rules tab fine-tune single actions
   ("always allow replying to my team", "never delete").
3. **Built-in actions: what about the AI's own tools?** AIs also have their own built-ins, like
   running commands or editing files. For AIs the gate fully controls (shown as **Enforced**, for
   example Claude), those go through the gate too. For AIs it can only partly control (**Advisory**),
   the gate can't see everything they do, so treat the rules as a strong guide, not a guarantee.

**What about the "provider permission mode"?** That's the AI's own setting for whether it asks
before acting. It only matters when nothing else is in charge: when a bot is **Unrestricted** (no
gate), or when its AI is **Advisory**. Otherwise the gate decides and the setting is hidden, so you
don't have to think about it. Bot Studio shows it, in plain words, in exactly those two cases.

Quick rules of thumb:
- Not sure? Leave the bot **Careful**. You can always raise it later.
- Move to **Trusted** once a bot has earned it, for example after a few dry runs.
- Use **Unrestricted** only for a bot you fully trust that never reads emails, web pages or other
  outside content, because anything it reads could try to give it orders.
- Changing autonomy applies the next time the bot runs, and you can change it back at any time.

---

## Creating a new bot
**New bot** opens the Architect, ten short steps (skip any you like):

1. **Purpose**: what the bot is for.
2. **Agent**: which AI runs it (Claude, Codex, Grok, Antigravity, …), whether the gate fully
   controls it, backup AIs if it's down, and an optional cheaper "watcher" AI for deciding whether
   something is worth waking up for. If the chosen AI can only be *partly* controlled by the gate,
   you'll also see its own permission setting here; otherwise you won't, because it doesn't matter.
3. **Brief**: the instructions.
4. **Goals**: what it's working toward. The Architect suggests one from your purpose.
5. **Tools**: which apps it can use (Gmail, Slack, Jira…).
6. **Wake-ups**: a schedule, plain-English times, webhooks, watchers, or "only when I message it".
7. **Outputs & actions**: what it produces and the buttons you get on each item.
8. **Guardrails**: how much the bot may do on its own (Careful, Trusted or Unrestricted, starting
   at Careful) with a one-sentence summary, quick choices such as "never delete" or "allow sending
   replies without asking", a budget (defaults: $5/day, $100/month, 12 wake-ups/hour) and a dry
   run. The AI's own permission setting only shows up here if you pick Unrestricted or the AI is
   only partly controlled.
9. **Reach me**: which channels it uses, quiet hours, and whether lessons may auto-apply.
10. **Review**: check everything and create.

When you press Create, Bot Studio sets up each piece and shows a tick for each. If something fails
you'll see what, and **Retry remaining** finishes the rest. The bot stays **paused** until
everything is in place, so it never runs without its limits.

---

## Where a bot keeps its things
Every bot has its own folder: `~/.cloudcli/bots/<bot id>/home/`
- `skills/`: its playbooks (Abilities → Skills)
- `spaces/`: its living documents (Abilities → Spaces)
- `scratch/`: throwaway working files (safe to delete)
- `browser-profile/`: its own browser logins, created the first time it opens a browser (use
  **Abilities → Accounts & logins → Sign the bot out everywhere** to clear it)

Bots that belong to a **project** do their work inside that project's folder instead. Their skills
and spaces still live in the bot folder. The folder is created the first time the bot wakes up.

---

## Two things that aren't there yet

**Email as a channel.** Today a bot can't email *you* its notifications. But a bot that has a mail
tool (Gmail through Composio or claude.ai Gmail) can already read and draft email as part of its
job. Sending still asks you first on a Careful bot, because "send" is on the safety floor.

**Docker / separate machines per bot.** Each bot already gets its own folder, browser profile and
logins, and the gate controls what it does. A container would add a hard wall around the files a
bot can touch on your Mac. That only matters for bots whose AI provider can't be fully controlled
by the gate. Since your Mac is always on, you don't need a separate machine.
