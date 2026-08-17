import fsSync from 'node:fs';
import path from 'node:path';
import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { normalizeSessionName } from '@/shared/utils.js';
import { findQwenTranscriptFiles, parseQwenMetadata } from './qwencode-sessions.provider.js';

export class QwenCodeSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    const files = await findQwenTranscriptFiles(since);
    let count = 0;
    for (const filePath of files) if (await this.index(filePath)) count += 1;
    return count;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    return (await this.index(filePath)) ? path.basename(filePath, '.jsonl') : null;
  }

  private async index(filePath: string): Promise<boolean> {
    try {
      const lines = (await fsSync.promises.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(0, 80);
      const records = lines.flatMap((line) => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; } });
      const metadata = parseQwenMetadata(records, path.basename(filePath, '.jsonl'));
      if (!metadata) return false;
      const stat = await fsSync.promises.stat(filePath);
      sessionsDb.createSession(metadata.sessionId, 'qwencode', metadata.projectPath, normalizeSessionName(metadata.title, 'Untitled Qwen Code Session'), stat.birthtime.toISOString(), stat.mtime.toISOString(), filePath);
      return true;
    } catch { return false; }
  }
}
