# TL Tasks → client work sessions

In Bot Studio, open **TL Tasks → Outputs & actions → Client work sessions**.

1. Enable client work sessions and select **Gemini 3.8 Flash (High)** from the installed Antigravity model list. Its verified catalog ID is `gemini-3.8-flash-high`.
2. Select **Fluxito** as a session MCP server. Its catalog binding must be enabled for Antigravity. Connect Composio/Trello for the bot's Produce phase separately.
3. Add each client's corresponding LA project. Add aliases for Trello's client names, for example `VAST` for `VAST Data` or `Check Point` for `Checkpoint`. Matching ignores case and punctuation, but never guesses an unlisted alias. These mappings take precedence over the bot's fixed Work this project.
4. Add shared instructions and per-client context, including the Fluxito workspace/project identity when known. Sessions start in the mapped local project, receive the task details and project-memory preamble, and are instructed to read project instructions and verify the client identity before using Fluxito.
5. Save. In **Propose**, use **Open work chat** to start a task. For automatic dispatch, enable the automatic-start checkbox and select **Act**. **Dry run** starts no work sessions.

The work provider/model are independent of the producer. TL Tasks can continue using Grok to collect cards while Antigravity does the work. This change preserves the existing Trello list/completion filters; edit the Produce brief to change which lists count as outstanding.

Automatic work is serialized per bot and continues with the browser closed. Only tasks produced or seen again after routing is configured enter the automatic queue; historical inbox cards are not all launched merely by enabling this feature. New ticks reuse the stored Trello card identity. Deleting and re-ingesting an inbox card also retains its session association.

Inbox cards link to their existing work session. Unknown clients, missing projects/models/MCP bindings, and runtime failures appear in Exceptions. After a server restart, interrupted sessions are marked for inspection rather than replayed automatically. Continue an interrupted or failed task in its existing session. Completing a work session resolves the CloudCLI inbox item; it does not automatically mark the Trello card complete.

Selected session MCPs are passed explicitly to Antigravity. Other globally enabled servers are not added to the work session. Held or denied policies on a selected MCP block unattended dispatch because Antigravity does not enforce these per-tool policies.

Implementation uses `mc_sections.work_profile_json` for settings and `mc_work_dispatches` for persistent dispatch identities. Existing bots without a work profile retain their previous behavior. Schema migrations run on server startup.
