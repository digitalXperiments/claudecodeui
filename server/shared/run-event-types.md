# Run Event Type Registry (v1)

Canonical list of `type` strings used in `RunEventEnvelope` (see
`server/shared/run-events.ts`). Every durable event appended to
`agent_run_events` MUST use one of these types or register a new one here
first (PRD §4.7).

| type | emitted when | payload keys (typical) |
|------|--------------|------------------------|
| `run.queued` | run enqueued | `trigger`, `source_ref` |
| `run.started` | provider process/session started | `pid?`, `cwd?` |
| `run.first_token` | first model token observed | `provider`, `model` |
| `run.status` | any status transition | `from`, `to` |
| `model.selected` | provider/model/effort resolved | `provider`, `model`, `effort?` |
| `workspace.bound` | workspace attached to run | `workspace_id`, `root_path`, `feature_branch` |
| `tool.call` | tool invocation (payload ≤ 4KB, secrets redacted) | `tool`, `args_summary` |
| `tool.result` | tool result (redacted) | `tool`, `ok`, `summary` |
| `permission.requested` | HITL permission prompt created | `permission_id`, `tool?` |
| `permission.resolved` | permission approved/denied | `permission_id`, `decision` |
| `approval.requested` | MC item needs review | `item_id` |
| `approval.resolved` | MC item reviewed | `item_id`, `decision` |
| `token.usage` | usage snapshot | `input`, `output`, `total`, `cost_usd_estimate?` |
| `git.commit` | commit created during run | `sha`, `message` |
| `git.diff_summary` | diff captured | `files`, `additions`, `deletions` |
| `test.started` | ship-loop test command started | `command` |
| `test.finished` | ship-loop test finished | `exit_code`, `duration_ms` |
| `run.completed` | terminal success | `exit_code?` |
| `run.failed` | terminal failure | `error_summary` |
| `run.aborted` | terminal abort | `reason?` |
| `failover.triggered` | P9 playbook fired | `playbook_id`, `from_provider`, `to_provider` |
| `pack.attached` | context pack attached (P7) | `pack_id`, `estimated_tokens` |

Rules:

- Payloads are JSON-serializable and MUST pass through the secrets redactor
  before persistence (PRD §8).
- `Authorization` headers, raw env dumps, and known secret values are never
  stored.
- `seq` is monotonic per `run_id`, assigned by the run repository.
