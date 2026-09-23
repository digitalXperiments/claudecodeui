/**
 * Tool catalog for the `cloudcli-agent-relay` MCP server, shared between the
 * stdio entrypoint (agent-relay-mcp.ts) and the server-side MCP tools
 * explorer, which needs these definitions without spawning a subprocess.
 */

export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

export const AGENT_RELAY_MCP_SERVER_NAME = 'cloudcli-agent-relay';

const taskSchema = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Bounded assignment with scope, constraints, and requested evidence.' },
    label: { type: 'string', description: 'Short display name (max 80 chars) used in status listings, session titles, and dependency references. Always set one — it keeps fleet views readable.' },
    provider: { type: 'string', description: 'Optional worker provider. Omit for round-robin routing across allowed workers.' },
    model: { type: 'string', description: 'Optional provider model id from relay_capabilities (Settings may allowlist a subset). Omit to use the allowlisted default, or the provider default when unrestricted.' },
    effort: { type: 'string', description: 'Optional model-supported effort/reasoning level from relay_capabilities.' },
    mode: { type: 'string', enum: ['read_only', 'isolated_write'], description: 'read_only inspects the project; isolated_write gets a separate worktree.' },
    approvalPolicy: { type: 'string', enum: ['auto', 'manual'], description: 'Leave unset. auto (default) never parks the lead: workers run inside an OS sandbox, in-sandbox actions are approved, boundary crossings are denied and reported as deniedActions. manual is honored only when the operator enabled lead-selectable manual approval; otherwise it is replaced by the operator default with a warning.' },
    timeoutMs: { type: 'number', description: 'Optional per-worker timeout in milliseconds.' },
    mcpServers: { type: 'array', items: { type: 'string' }, description: 'Optional CloudCLI MCP catalog server names for the worker. Only providers reporting honorsMcpGrants in relay_capabilities apply these.' },
    outputSchema: { type: 'object', description: 'Optional JSON Schema (subset: type/properties/required/items/enum/anyOf) the worker\'s structured "data" output must satisfy. Validated server-side; one automatic repair turn is sent on violation, and the verdict is reported as result.outputValidation.' },
    dependsOn: { type: 'array', items: { type: 'number' }, description: 'Zero-based indices of earlier tasks in this same batch. The task stays queued until they complete, and their summaries plus structured outputs are injected into its prompt — a one-call pipeline. An isolated_write task that depends on writers starts from their combined branch (stacked pipeline); a read_only task that depends on a writer inspects that writer\'s worktree. If a dependency fails or is blocked, this task fails fast.' },
    retries: { type: 'number', description: 'Automatic re-dispatches (0-2, default 0) after an infrastructure failure that produced no output. Quota/auth/launch failures additionally fail over to another authenticated provider automatically.' },
    requires: {
      type: 'object',
      description: 'Declare what the worker needs; checked before dispatch (the task is rejected with a clear reason instead of the worker discovering it mid-run). MCP servers listed here are granted automatically and force a provider that honors grants.',
      properties: {
        mcpServers: { type: 'array', items: { type: 'string' } },
        network: { type: 'boolean', description: 'Needs network egress (package installs, APIs).' },
        commands: { type: 'array', items: { type: 'string' }, description: 'Command-line tools that must be installed, e.g. ["swift", "docker"].' },
      },
    },
  },
  required: ['task'],
};

export const AGENT_RELAY_MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'relay_templates',
    description: 'List built-in versioned investigation, implementation-review, and adversarial-review workflow templates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'relay_run_template',
    description: 'Instantiate and dispatch a validated built-in workflow template as one dependency-aware Relay batch.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', enum: ['investigate', 'implement-test-review', 'adversarial-review'] },
        projectPath: { type: 'string' },
        inputs: { type: 'object', description: 'Template inputs. objective is required; templates metadata lists optional fields.' },
      },
      required: ['templateId', 'inputs'],
    },
  },
  {
    name: 'relay_scorecard',
    description: 'Aggregate durable relay outcomes, validation failures, retries, duration, and reported cost for this lead session. Worker evidence is not treated as host-verified.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'relay_delegate',
    description: 'Lead orchestrator only: launch up to 20 worker tasks (optional dependsOn pipelines) instead of doing the work yourself. Returns immediately with durable relay ids. Do not grep, edit, test, or implement in the lead session — dispatch a worker. Delegated workers must not call this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute project path. Defaults to the MCP process working directory.' },
        tasks: { type: 'array', minItems: 1, maxItems: 20, items: taskSchema },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'relay_status',
    description: 'Read compact status summaries (label, provider, requested/selected/resolved model identity, effort, status, result summary, token usage, pending approvals) for this chat\'s relay jobs. Omit ids to list every relay this chat owns. Fetch one job\'s full raw output with relay_result.',
    inputSchema: {
      type: 'object',
      properties: {
        relayId: { type: 'string' },
        relayIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'relay_wait',
    description: 'Wait up to 60 seconds for any or all requested relay jobs; returns compact summaries. Harvest incrementally: pass only unfinished ids with returnWhen "any". Returns immediately if a worker is blocked on a permission request you must answer with relay_approve or relay_deny.',
    inputSchema: {
      type: 'object',
      properties: {
        relayIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        returnWhen: { type: 'string', enum: ['any', 'all'], default: 'any' },
        timeoutMs: { type: 'number', maximum: 60000, default: 30000 },
      },
      required: ['relayIds'],
    },
  },
  {
    name: 'relay_result',
    description: 'Fetch one finished job\'s complete result with provider, requested/selected/resolved model identity, effort, full summary, evidence, validated structured output, and the worker\'s raw final output (can be large — pull one job at a time, not the whole fleet).',
    inputSchema: {
      type: 'object',
      properties: {
        relayId: { type: 'string' },
        includeOutput: { type: 'boolean', default: true, description: 'Set false to omit the raw output text and keep only the structured fields.' },
      },
      required: ['relayId'],
    },
  },
  {
    name: 'relay_follow_up',
    description: 'Send the delegate additional instructions — works both mid-session (running, queued, or parked on an approval; delivered into its live turn or, failing that, as the prompt for its very next turn, without waiting for it to finish) and after it has finished (resumes the session for another attempt). The worker keeps its context; the declared outputSchema still applies.',
    inputSchema: {
      type: 'object',
      properties: { relayId: { type: 'string' }, prompt: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['relayId', 'prompt'],
    },
  },
  {
    name: 'relay_cancel',
    description: 'Cancel a queued or running relay job. Partial findings are preserved as a blocked result when the worker had produced output.',
    inputSchema: { type: 'object', properties: { relayId: { type: 'string' } }, required: ['relayId'] },
  },
  {
    name: 'relay_diff',
    description: 'Inspect the changed files and optional bounded patches from an isolated-write relay job. This never merges changes.',
    inputSchema: {
      type: 'object',
      properties: { relayId: { type: 'string' }, includePatch: { type: 'boolean', default: false } },
      required: ['relayId'],
    },
  },
  {
    name: 'relay_peek',
    description: 'See what a running worker is actually doing right now: elapsed time, idle time, tool-call trail, a live tail of its streamed prose (recentOutput), and any pending approval. Use this instead of waiting blindly on a long job.',
    inputSchema: {
      type: 'object',
      properties: {
        relayId: { type: 'string' },
        limit: { type: 'number', description: 'How many recent activity entries to return (default 20, max 100).' },
      },
      required: ['relayId'],
    },
  },
  {
    name: 'relay_verify',
    description: 'Run host-side checks in one completed Relay writer worktree at its committed tip. Usually unnecessary: the server verifies every writer automatically when it finishes and records the result in the job\'s delivery state. Projects with no configured check report unavailable (not a failure).',
    inputSchema: { type: 'object', properties: { relayId: { type: 'string' }, commands: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: ['relayId'] },
  },
  {
    name: 'relay_rehearse',
    description: 'Apply the selected writers\' own changes onto a throwaway copy of the primary checkout exactly as it is now (including uncommitted work) and run the project checks there. Usually automatic: when a batch settles the server rehearses its verified final-stage writers and reports the rehearsalId in the wake-up.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: 'Optional; defaults to the first relay\'s project.' }, relayIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['relayIds'] },
  },
  {
    name: 'relay_unlanded',
    description: 'List this lead\'s writer workspaces that are not landed yet, with their changed-file counts and delivery stage.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
  },
  {
    name: 'relay_land',
    description: 'Land a passing rehearsal onto the primary checkout: every rehearsed writer, or just relayId. Works on a dirty checkout: each file is applied (three-way merged where the operator also edited it); paths that were clean are committed, paths carrying the operator\'s own edits are written but left uncommitted, and anything that cannot be placed is reported as a conflict. Landed worktrees and branches are cleaned up.',
    inputSchema: { type: 'object', properties: { rehearsalId: { type: 'string' }, relayId: { type: 'string', description: 'Optional: land only this writer from the rehearsal.' }, commit: { type: 'boolean', description: 'Default true.' } }, required: ['rehearsalId'] },
  },
  {
    name: 'relay_discard',
    description: 'Throw away a writer\'s worktree and branch without landing it.',
    inputSchema: { type: 'object', properties: { relayId: { type: 'string' } }, required: ['relayId'] },
  },
  {
    name: 'relay_pending_approvals',
    description: 'List worker permission requests that fell outside the task\'s declared envelope and are waiting on your decision. A blocked worker stays parked until you answer or the approval budget expires.',
    inputSchema: {
      type: 'object',
      properties: { relayId: { type: 'string', description: 'Optional: only this job\'s pending requests.' } },
    },
  },
  {
    name: 'relay_approve',
    description: 'Approve one pending worker permission request. Only manual-policy jobs (an operator setting) park; auto jobs run in an OS sandbox and never wait on you. Approve only what the assignment genuinely needs.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string' },
        reason: { type: 'string', description: 'Short justification recorded in the audit trail.' },
      },
      required: ['approvalId'],
    },
  },
  {
    name: 'relay_deny',
    description: 'Deny one pending worker permission request. The worker resumes with the denial reason and can report the blocker instead of stalling.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string' },
        reason: { type: 'string', description: 'Short explanation handed to the worker.' },
      },
      required: ['approvalId'],
    },
  },
  {
    name: 'relay_capabilities',
    description: 'Call this before any repo work. Lists allowed worker providers, model catalogs, defaults, effort levels, seats (readOnlyPlanSeat, honorsMcpGrants), and hard limits. The lead is an orchestrator: after this call, dispatch with relay_delegate rather than searching or editing locally.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'studio.create_prototype',
    description: 'Create a CloudCLI Studio prototype in the current chat project. The ambient lead session is linked automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        brief: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
      },
      required: ['brief'],
    },
  },
  {
    name: 'studio.list_prototypes',
    description: 'List Studio prototypes for the current chat project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'studio.get_prototype',
    description: 'Read one Studio prototype and its current HTML, notes, handoff, and versions.',
    inputSchema: {
      type: 'object',
      properties: { prototypeId: { type: 'string' } },
      required: ['prototypeId'],
    },
  },
  {
    name: 'studio.iterate_prototype',
    description: 'Request a focused Studio prototype iteration from the current chat.',
    inputSchema: {
      type: 'object',
      properties: { prototypeId: { type: 'string' }, message: { type: 'string' } },
      required: ['prototypeId', 'message'],
    },
  },
  {
    name: 'studio.attach_session',
    description: 'Attach the current ambient chat session to a Studio prototype.',
    inputSchema: {
      type: 'object',
      properties: { prototypeId: { type: 'string' } },
      required: ['prototypeId'],
    },
  },
];
