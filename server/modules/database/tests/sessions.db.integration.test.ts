import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const restoredSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('sessions from CloudCLI worktrees stay under their parent project', async () => {
  await withIsolatedDatabase(() => {
    const parentProject = projectsDb.createProjectPath('/workspace/demo-project').project;
    assert.ok(parentProject);
    const workspacePath = '/workspace/demo-project/.cloudcli/worktrees/ws_test';
    const db = getConnection();

    db.prepare(`
      INSERT INTO agent_workspaces (
        workspace_id, project_id, run_id, task_id, mode, root_path,
        base_branch, base_sha, feature_branch, head_sha, status
      ) VALUES (?, ?, NULL, NULL, 'git_worktree', ?, 'main', NULL, 'chat/test', NULL, 'active')
    `).run('ws_test', parentProject.project_id, workspacePath);

    sessionsDb.createSession('workspace-session', 'claude', workspacePath, 'Workspace session');

    assert.equal(sessionsDb.getSessionById('workspace-session')?.project_path, parentProject.project_path);
    assert.equal(sessionsDb.getSessionById('workspace-session')?.runtime_project_path, workspacePath);
    assert.equal(projectsDb.getProjectPath(workspacePath), null);
  });
});

test('app sessions preserve the workspace cwd while using the parent project as owner', async () => {
  await withIsolatedDatabase(() => {
    const parentProject = projectsDb.createProjectPath('/workspace/demo-project').project;
    assert.ok(parentProject);
    const workspacePath = '/workspace/demo-project/.cloudcli/worktrees/ws_app';
    const db = getConnection();

    db.prepare(`
      INSERT INTO agent_workspaces (
        workspace_id, project_id, run_id, task_id, mode, root_path,
        base_branch, base_sha, feature_branch, head_sha, status
      ) VALUES (?, ?, NULL, NULL, 'git_worktree', ?, 'main', NULL, 'chat/app', NULL, 'active')
    `).run('ws_app', parentProject.project_id, workspacePath);

    sessionsDb.createAppSession('app-workspace-session', 'cursor', workspacePath);

    const row = sessionsDb.getSessionById('app-workspace-session');
    assert.equal(row?.project_path, parentProject.project_path);
    assert.equal(row?.runtime_project_path, workspacePath);
  });
});

test('sessions from temporary directories stay under the parent directory', async () => {
  await withIsolatedDatabase(() => {
    const runtimePath = '/tmp/cloudcli-session-test';

    sessionsDb.createSession('temporary-session', 'claude', runtimePath, 'Temporary session');

    const row = sessionsDb.getSessionById('temporary-session');
    assert.equal(row?.project_path, '/tmp');
    assert.equal(row?.runtime_project_path, runtimePath);
    assert.equal(projectsDb.getProjectPath(runtimePath), null);
    assert.ok(projectsDb.getProjectPath('/tmp'));
  });
});

test('pending temporary app sessions match their exact runtime directory', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('temporary-app-session-a', 'claude', '/tmp/cloudcli-session-a');
    sessionsDb.createAppSession('temporary-app-session-b', 'claude', '/tmp/cloudcli-session-b');

    assert.equal(
      sessionsDb.findLatestPendingAppSession('claude', '/tmp/cloudcli-session-a')?.session_id,
      'temporary-app-session-a',
    );
    assert.equal(
      sessionsDb.findLatestPendingAppSession('claude', '/tmp/cloudcli-session-b')?.session_id,
      'temporary-app-session-b',
    );
  });
});

test('legacy workspace project rows are rehomed and archived', async () => {
  await withIsolatedDatabase(() => {
    const parentProject = projectsDb.createProjectPath('/workspace/demo-project').project;
    assert.ok(parentProject);
    const workspacePath = '/workspace/demo-project/.cloudcli/worktrees/ws_legacy';
    projectsDb.createProjectPath(workspacePath);

    const db = getConnection();
    db.prepare(`
      INSERT INTO agent_workspaces (
        workspace_id, project_id, run_id, task_id, mode, root_path,
        base_branch, base_sha, feature_branch, head_sha, status
      ) VALUES (?, ?, NULL, NULL, 'git_worktree', ?, 'main', NULL, 'chat/legacy', NULL, 'active')
    `).run('ws_legacy', parentProject.project_id, workspacePath);
    db.prepare(`
      INSERT INTO sessions (
        session_id, provider, provider_session_id, project_path, isArchived
      ) VALUES (?, ?, ?, ?, 0)
    `).run('legacy-workspace-session', 'claude', 'legacy-workspace-session', workspacePath);

    assert.equal(sessionsDb.rehomeAgentWorkspaceSessions(), 1);
    assert.equal(
      sessionsDb.getSessionById('legacy-workspace-session')?.project_path,
      parentProject.project_path,
    );
    assert.equal(
      sessionsDb.getSessionById('legacy-workspace-session')?.runtime_project_path,
      workspacePath,
    );
    assert.equal(projectsDb.getProjectPath(workspacePath)?.isArchived, 1);
    assert.equal(projectsDb.getProjectPaths().some((project) => project.project_path === workspacePath), false);
    assert.equal(projectsDb.getArchivedProjectPaths().some((project) => project.project_path === workspacePath), false);
  });
});

test('legacy temporary project rows are rehomed and archived', async () => {
  await withIsolatedDatabase(() => {
    const runtimePath = '/tmp/legacy-session-dir';
    projectsDb.createProjectPath(runtimePath);

    const db = getConnection();
    db.prepare(`
      INSERT INTO sessions (
        session_id, provider, provider_session_id, project_path, isArchived
      ) VALUES (?, ?, ?, ?, 0)
    `).run('legacy-temporary-session', 'claude', 'legacy-temporary-session', runtimePath);

    assert.equal(sessionsDb.rehomeAgentWorkspaceSessions(), 1);
    assert.equal(
      sessionsDb.getSessionById('legacy-temporary-session')?.project_path,
      '/tmp',
    );
    assert.equal(
      sessionsDb.getSessionById('legacy-temporary-session')?.runtime_project_path,
      runtimePath,
    );
    assert.equal(projectsDb.getProjectPath(runtimePath)?.isArchived, 1);
    assert.equal(projectsDb.getProjectPaths().some((project) => project.project_path === runtimePath), false);
    assert.equal(projectsDb.getArchivedProjectPaths().some((project) => project.project_path === runtimePath), false);
  });
});
