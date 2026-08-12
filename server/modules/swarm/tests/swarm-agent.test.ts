import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  configureSwarmRuntimes,
  runSwarmAgent,
} from '@/modules/swarm/swarm-agent.service.js';
import { runService } from '@/modules/runs/index.js';

test('runSwarmAgent persists its title and passes it to Grok as sessionSummary', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('swarm-agent-');
  const projectPath = path.join(root, 'project');
  const title = 'Swarm Builder: Implement session labels';
  let runtimeOptions: Record<string, unknown> | null = null;

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });

  configureSwarmRuntimes({
    grok: async (_command, options, writer) => {
      runtimeOptions = options;
      const providerWriter = writer as {
        send: (message: unknown) => void;
        setSessionId: (sessionId: string) => void;
      };
      providerWriter.setSessionId('grok-native-session');
      providerWriter.send({
        kind: 'complete',
        provider: 'grok',
        exitCode: 0,
        success: true,
      });
    },
  });

  try {
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const run = runService.create({
      source: 'swarm',
      projectId,
      provider: 'grok',
      title,
    });

    const outcome = await runSwarmAgent({
      projectId,
      projectPath,
      provider: 'grok',
      prompt: 'Run the swarm task.',
      runId: run.run_id,
      title: `  ${title}  `,
    });

    assert.equal(outcome.success, true);
    assert.equal((runtimeOptions as Record<string, unknown> | null)?.sessionSummary, title);

    const session = sessionsDb.getSessionById(outcome.appSessionId);
    assert.equal(session?.custom_name, title);
    assert.equal(session?.provider_session_id, 'grok-native-session');
  } finally {
    configureSwarmRuntimes({});
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
