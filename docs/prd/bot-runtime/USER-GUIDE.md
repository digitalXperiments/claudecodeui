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
2. **A bot asks before doing anything risky.** Reading and drafting are fine. Sending, publishing,
   deleting, buying, touching passwords or changing a live system always ask you first, unless you
   have told that one bot it's OK.
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
  edit them here.
- **Peer traffic** shows who asked whom for what.

---

## One bot's screens (click a bot → the tabs along the top)

### Overview
Same as before: counts, the brief, the latest wake-ups and items.

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
**What the bot may do without asking, and what it may spend.**
- **Enforcement** shows how strictly the gate controls this bot. *Enforced* means every tool call
  and built-in action goes through the gate.
- **Safety floor**: the six risky kinds of action (send, publish, delete, purchase, credentials,
  production changes) always ask you, unless you add an explicit rule for this one bot.
- **Rules**: "always allow X", "always ask before Y", "never do Z". Type a tool name and the screen
  tells you how risky it is. Clicking *Always allow* on an approval card creates one of these for
  you, and it expires after 30 days.
- **Gate decisions**: the full log of what was allowed, asked and blocked, and why.
- **Budget**: daily and monthly dollar limits, a daily action limit and a wake-ups-per-hour limit,
  with meters. At 80% the bot switches to a cheaper model. At 100% it stops until tomorrow.
- **Credentials**: the bot can have its own logins for a tool (separate from yours). Values are
  write-only and never shown again.
- **Failover**: if the main AI provider is down or rate-limited, try these others, in order. It
  never retries after the bot has already done something like sending, so nothing happens twice.

### Learning
**What the bot has learned, and what it wants to learn.**
- **Proposals**: lessons suggested from your feedback, such as a memory ("ignore Medium digests"),
  a rule ("you approved this 5 times, allow it?") or a skill ("save this as a playbook"). Approve
  (you can edit first) or reject. Nothing applies until you approve.
- **Skills**: playbooks the bot follows, written as simple step lists. Edit, switch off or delete them.
- **Teach mode**: show the bot a browser task once. It records your clicks (never passwords) and
  drafts a skill from them, switched off until you review it.
- **Preferences**: facts about *you* that every bot reads (shared across bots).
- **Privacy**: download everything the bot knows, or wipe selected parts.

### Pipeline, Test, History, Settings
Unchanged: the bot's instructions and tools, a dry-run simulator, past runs and versions, trust and
memory settings, and delete.

---

## Creating a new bot
**New bot** opens the Architect. It walks you through the purpose, the AI, the brief and tools, then
triggers, goals, guardrails (safety floor, budget, quick rules), how it reaches you, and a review.
The bot starts **paused**, so you can watch its first wake-up before letting it run on its own.

---

## Where a bot keeps its things
Every bot has its own folder: `~/.cloudcli/bots/<bot id>/home/`
- `skills/`: its playbooks
- `spaces/`: its living documents
- `scratch/`: throwaway working files (safe to delete)
- `browser-profile/`: its own browser logins, created the first time it opens a browser (delete
  this to sign it out everywhere)

Bots that belong to a **project** do their work inside that project's folder instead. Their skills
and spaces still live in the bot folder. The folder is created the first time the bot wakes up.

---

## Two things that aren't there yet

**Email as a channel.** Today a bot can't email *you* its notifications. But a bot that has a mail
tool (Gmail through Composio or claude.ai Gmail) can already read and draft email as part of its
job. Sending still asks you first, because "send" is on the safety floor.

**Docker / separate machines per bot.** Each bot already gets its own folder, browser profile and
logins, and the gate controls what it does. A container would add a hard wall around the files a
bot can touch on your Mac. That only matters for bots whose AI provider can't be fully controlled
by the gate. Since your Mac is always on, you don't need a separate machine.
