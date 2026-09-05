# Integration Rehearsal

Dry-run combine **committed** workspace branch tips from the **same project** in a disposable git worktree. The primary checkout, index, uncommitted files, and feature branches are never merged or rewritten.

## Who it is for

Operators who want to know whether two or more completed agent workspaces would merge and pass the project's existing Ship test command **before** applying anything to the primary branch.

## How to run

1. Open **Workspaces** for a registered project.
2. Select at least two completed git worktrees (`active` or `merged` with a feature branch).
3. Paste the **explicit common base SHA** (the ancestor both tips share; typically `base_sha` recorded on the workspaces).
4. Click **Rehearse integration**.

The server:

1. Rejects dirty worktrees, other projects, unsafe refs, and fewer than two workspaces.
2. Creates `tmp/cloudcli/rehearsals/<project>/<id>` + branch `rehearsal/<id>` from the resolved base SHA.
3. Merges each recorded **committed tip SHA** in order.
4. On textual conflict: abort merge, report conflict paths, **do not run tests**.
5. On a clean merge: run the project's Ship test command from `.cloudcli/ship.yaml` / `ship.yml` / `ship.json` (same config Ship uses). The command is argv-split (no shell).
6. Always removes the rehearsal worktree, branch, and subprocess (success, conflict, test failure, or timeout).

## Result fields

- `inputs[]`: workspace id, feature branch, exact `head_sha` used
- `base_sha`: resolved 40-character SHA
- `merge_conflicts[]` vs `test.{command,cwd,stdout,stderr,exit_code,duration_ms,timed_out,passed}`
- `warnings`: uncommitted edits are excluded; dirty worktrees are rejected instead of silently including them
- `cleaned_up`

## API

- `POST /api/projects/:projectId/workspaces/integration-rehearsal` `{ workspaceIds, baseSha }`
- `GET /api/projects/:projectId/workspaces/integration-rehearsal` last in-process result

Project identity comes from the project registry. Callers cannot pick an arbitrary filesystem path.

## Out of scope

- Automatic merge back to the primary branch
- Shared memory / Obsidian MCP (reuse the existing skill; this feature does not store decisions)
- Studio, Ship routes, or agent-relay changes
