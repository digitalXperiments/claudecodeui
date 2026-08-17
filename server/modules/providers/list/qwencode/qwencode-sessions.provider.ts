import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { parseImagesInputTag } from '@/shared/image-attachments.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

export const QWEN_PROVIDER = 'qwencode' as const;
export const qwenRuntimeRoot = () => process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || path.join(os.homedir(), '.qwen');

async function walk(root: string, since?: Date): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await fsSync.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (since) { try { if ((await fsSync.promises.stat(filePath)).mtime < since) continue; } catch { continue; } }
        result.push(filePath);
      }
    }
  };
  await visit(root);
  return result;
}

export async function findQwenTranscriptFiles(since?: Date): Promise<string[]> {
  return walk(qwenRuntimeRoot(), since);
}

const textParts = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    const record = readObjectRecord(part);
    return typeof record?.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
};

const recordText = (record: AnyRecord | null): string => {
  const message = readObjectRecord(record?.message);
  return textParts(message?.parts ?? record?.parts ?? record?.content);
};

export type QwenSessionMetadata = { sessionId: string; projectPath: string; title?: string };

export function parseQwenMetadata(records: AnyRecord[], fallbackId: string): QwenSessionMetadata | null {
  const first = records.find((record) => typeof record.cwd === 'string' || typeof record.sessionId === 'string');
  const sessionId = records.map((record) => typeof record.sessionId === 'string' ? record.sessionId : '').find(Boolean) ?? fallbackId;
  const projectPath = first && typeof first.cwd === 'string' ? first.cwd : '';
  if (!sessionId || !projectPath) return null;
  const titleRecord = records.find((record) => record.subtype === 'custom_title');
  const payload = readObjectRecord(titleRecord?.systemPayload);
  const title = typeof payload?.customTitle === 'string' ? payload.customTitle : undefined;
  return { sessionId, projectPath, title };
}

async function readRecords(filePath: string): Promise<AnyRecord[]> {
  const records: AnyRecord[] = [];
  if (!fsSync.existsSync(filePath)) return records;
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try { const value = readObjectRecord(JSON.parse(line)); if (value) records.push(value); } catch { /* tolerate a partial final line */ }
  }
  return records;
}

export class QwenCodeSessionsProvider implements IProviderSessions {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (typeof raw?.sessionUpdate === 'string') {
      if (raw.sessionUpdate === 'agent_thought_chunk') {
        const text = readObjectRecord(raw.content)?.text;
        return typeof text === 'string' && text ? [createNormalizedMessage({ kind: 'thinking', content: text, sessionId, provider: QWEN_PROVIDER })] : [];
      }
      if (raw.sessionUpdate === 'agent_message_chunk') {
        const text = readObjectRecord(raw.content)?.text;
        return typeof text === 'string' && text ? [createNormalizedMessage({ kind: 'stream_delta', content: text, sessionId, provider: QWEN_PROVIDER })] : [];
      }
      if (raw.sessionUpdate === 'tool_call_update' && (raw.status === 'completed' || raw.status === 'failed')) {
        const content = typeof raw.rawOutput === 'string' ? raw.rawOutput : textParts(raw.content);
        return [createNormalizedMessage({ kind: 'tool_result', toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '', content, isError: raw.status === 'failed', sessionId, provider: QWEN_PROVIDER })];
      }
      if (raw.sessionUpdate === 'tool_call_update' && raw.rawInput) {
        return [createNormalizedMessage({ kind: 'tool_use', toolName: typeof raw.title === 'string' ? raw.title : 'Tool', toolInput: raw.rawInput, toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : generateMessageId('qwen'), sessionId, provider: QWEN_PROVIDER })];
      }
      return [];
    }
    if (raw?.type === 'user') {
      const content = recordText(raw); const parsed = parseImagesInputTag(content);
      return parsed.text.trim() || parsed.attachments.length ? [createNormalizedMessage({ kind: 'text', role: 'user', content: parsed.text, images: parsed.attachments.length ? parsed.attachments : undefined, sessionId, provider: QWEN_PROVIDER })] : [];
    }
    if (raw?.type === 'assistant') {
      const content = recordText(raw);
      return content.trim() ? [createNormalizedMessage({ kind: 'text', role: 'assistant', content, sessionId, provider: QWEN_PROVIDER })] : [];
    }
    return [];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const files = await findQwenTranscriptFiles();
    const providerSessionId = options.providerSessionId ?? sessionId;
    const filePath = files.find((candidate) => path.basename(candidate, '.jsonl') === providerSessionId) || files.find((candidate) => path.basename(candidate, '.jsonl') === sessionId);
    if (!filePath) return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    const records = await readRecords(filePath);
    const messages = records.flatMap((record) => this.normalizeMessage(record, sessionId)).filter((message) => message.kind !== 'tool_result');
    const { limit = null, offset = 0 } = options;
    const page = sliceTailPage(messages, limit, offset);
    return { messages: page.page, total: messages.length, hasMore: page.hasMore, offset, limit };
  }
}
