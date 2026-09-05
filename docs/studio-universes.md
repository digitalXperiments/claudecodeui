# Studio · Parallel Universes

Parallel Universes is a Studio feature for exploring one goal through **two
named, independent implementation approaches** against the *actual* selected
project repository — not a synthetic HTML mock like the rest of Studio's
clickable-prototype flow. Each approach runs as its own isolated Agent Relay
job, so the two attempts never touch each other's files, and you can preview,
diff, and deliberately apply whichever one wins.

Access it from **Design Studio → Universes** (the toggle next to "Prototypes"
in the Studio header).

## How it works

1. **Describe the goal**, then name two alternative approaches (e.g.
   "Optimistic UI" vs. "Server-validated") and pick a provider + model for
   each from your existing catalogs (Agent Relay's allowed worker providers,
   and each provider's live model catalog). Provider and model are always
   explicit — there is no silent fallback to a default model that could incur
   an unexpected expensive run.
2. **Launch** dispatches both approaches as one Agent Relay batch, each with
   `mode: "isolated_write"`. Agent Relay creates an isolated git worktree (or
   a `sandbox_copy` for a non-git project) and a feature branch per job, then
   runs the worker there. Studio Universes only coordinates — job dispatch,
   worker execution, and workspace/branch lifecycle stay fully owned by
   Agent Relay and the workspaces module (`server/modules/agent-relay`,
   `server/modules/workspaces`).
3. **Compare.** Each variant card shows live status (queued/running/
   completed/failed/…), the worker's reported summary/evidence/tests, its
   feature branch, and a **Diff** view (file list + patches) pulled straight
   from the job's workspace.
4. **Preview.** Give a variant an explicit start command (e.g. `npm run
   dev`); Studio allocates a free local port, runs the command inside that
   variant's isolated workspace, and gives you an "Open" link once the port
   responds. Stopping a preview kills its process (and process group) and
   frees the port. Preview state is intentionally **not** resumable across a
   server restart: a pid that outlived the process which spawned it cannot be
   safely re-owned, so Studio reports it as stopped rather than pretending
   otherwise, and you just start it again.
5. **Apply.** When you've picked a winner, **Apply this variant** copies its
   changed files onto the primary checkout via the workspaces module's
   `applyToPrimary` (file-copy only, with an optional commit) — never an
   automatic `git merge`/`git rebase`, and never a publish/push. Files where
   your primary checkout already has uncommitted, divergent changes are
   skipped and reported, not silently overwritten.

Nothing here auto-merges, auto-publishes, or auto-picks a "winning" model
default. Every consequential step — launch, apply — is an explicit action you
take after the fact.

## Decisions and lessons

Studio Universes deliberately does **not** maintain its own decision log or
notes system. If you want to record why you picked one approach over
another, use your existing Obsidian MCP / shared memory skill for that — this
feature only persists the execution bookkeeping needed to resume and compare
variants (job/workspace/branch ids, statuses, applied results), not judgment
calls about the work.

## API

Mounted under the existing Studio router at
`/api/studio/:projectId/universes` (authenticated the same way as the rest of
`/api/studio`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/` | List universes for a project (statuses refreshed from Agent Relay on read). |
| `POST` | `/` | Create a universe: `{ goal, approaches: [approachA, approachB], timeoutMs? }`. Each approach is `{ label, approach, provider, model }`. |
| `GET`  | `/:id` | Get one universe, refreshed. |
| `DELETE` | `/:id` | Forget this universe in Studio (stops any local previews, deletes the Studio-owned manifest). Does **not** touch the underlying Agent Relay jobs or workspaces — those keep their own lifecycle/retention. |
| `POST` | `/:id/variants/:variantId/cancel` | Cancel the variant's Agent Relay job. |
| `GET`  | `/:id/variants/:variantId/diff` | File-level diff for the variant's workspace (`?patch=false` to omit patch text). |
| `POST` | `/:id/variants/:variantId/apply` | Apply the variant onto the primary checkout: `{ commit?, message? }`. |
| `POST` | `/:id/variants/:variantId/preview/start` | Start a local preview: `{ command, port? }`. |
| `POST` | `/:id/variants/:variantId/preview/stop` | Stop the local preview. |

## Known limitations (v1)

- Exactly **two** named approaches per universe, matching the primary use
  case this ships for. A future iteration could generalize the count.
- A preview process is only tracked by the CloudCLI server process that
  started it — it does not survive a server restart (see above).
- Applying a variant is a file-copy onto the primary checkout, not a git
  merge; it does not resolve conflicts beyond skipping files your primary
  checkout has already diverged on.
