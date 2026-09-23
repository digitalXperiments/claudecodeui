# CloudCLI Lite Agent Relay

The mobile Relay screen is available from **Relay** in the Projects and
Sessions headers, or at `#/relay`. It uses the authenticated Agent Relay REST
surface only:

- `GET /api/agent-relay/jobs` with `projectId`, `sessionId`, `active`, and
  `limit` filters. Jobs are grouped by their returned `batch_id`.
- `GET /api/agent-relay/jobs/:relayId/peek` supplies `idleMs`, recent activity,
  and live output for active workers.
- `GET /api/agent-relay/approvals` and
  `POST /api/agent-relay/approvals/:approvalId/decide` provide the approvals
  inbox and approve/deny actions.
- `POST /api/agent-relay/jobs/:relayId/cancel` and
  `POST /api/agent-relay/jobs/:relayId/follow-up` control a worker.

Polling runs while the Relay screen is visible, pauses when the document is
hidden, and resumes after visibility or network recovery. The page intentionally
stays ES5/Safari 9 compatible; run `node public/mweb/check-legacy.mjs` after
editing the inline screen.
