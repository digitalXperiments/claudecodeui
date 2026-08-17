import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { getClineDataDirectory, readObjectRecord, readOptionalString } from '@/shared/utils.js';

export class ClineSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly tasksPath = path.join(getClineDataDirectory(), 'tasks');

  async synchronize(): Promise<number> {
    let entries;
    try { entries = await readdir(this.tasksPath, { withFileTypes: true }); } catch { return 0; }
    let processed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await this.synchronizeTask(entry.name)) processed += 1;
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    const taskId = path.basename(path.dirname(filePath));
    if (!taskId || path.dirname(filePath) === this.tasksPath) return null;
    return await this.synchronizeTask(taskId) ? taskId : null;
  }

  private async synchronizeTask(taskId: string): Promise<boolean> {
    const taskPath = path.join(this.tasksPath, taskId);
    try {
      const metadata = readObjectRecord(JSON.parse(await readFile(path.join(taskPath, 'task_metadata.json'), 'utf8'))) ?? {};
      const projectPath = readOptionalString(metadata.cwd) ?? readOptionalString(metadata.workspacePath) ?? readOptionalString(metadata.directory);
      if (!projectPath) return false;
      sessionsDb.createSession(taskId, 'cline', projectPath, readOptionalString(metadata.title) ?? 'Cline Session', undefined, undefined, taskPath);
      return true;
    } catch {
      return false;
    }
  }
}
