/**
 * Maps Codex app-server `item/completed` items onto the legacy item shape that
 * CodexSessionsProvider.normalizeMessage() understands. Kept dependency-free so
 * it can be unit tested without loading the whole Codex runtime.
 *
 * Returns null for items that must not render (e.g. userMessage, whose bubble
 * comes from the local echo / rollout history).
 */
export function appServerItemToLegacy(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const base = { type: 'item', uuid: item.id };
  switch (item.type) {
    case 'agentMessage':
      // Codex uses commentary agent messages for progress/narration and
      // final_answer for the reply proper. Keep commentary on the existing
      // reasoning path so it is rendered as one collapsible thinking block
      // instead of looking like a normal assistant answer.
      if (item.phase === 'commentary') {
        return {
          ...base,
          itemType: 'reasoning',
          message: {
            role: 'assistant',
            content: item.text || '',
            isReasoning: true,
          },
        };
      }
      return {
        ...base,
        itemType: 'agent_message',
        message: { role: 'assistant', content: item.text || '' },
      };
    case 'reasoning':
      return {
        ...base,
        itemType: 'reasoning',
        message: {
          role: 'assistant',
          content: Array.isArray(item.summary) ? item.summary.join('\n') : '',
          isReasoning: true,
        },
      };
    case 'commandExecution':
      return {
        ...base,
        itemType: 'command_execution',
        command: item.command,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        status: item.status,
      };
    case 'fileChange':
      return {
        ...base,
        itemType: 'file_change',
        changes: item.changes,
        status: item.status,
      };
    case 'mcpToolCall':
      return {
        ...base,
        itemType: 'mcp_tool_call',
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      };
    case 'webSearch':
      return {
        ...base,
        itemType: 'web_search',
        query: item.query,
        status: item.status,
      };
    case 'plan':
      return {
        ...base,
        itemType: 'todo_list',
        items: item.text ? [{ text: item.text, completed: false }] : [],
        status: item.status,
      };
    case 'userMessage':
      // The user's bubble already comes from the local echo (live) and from
      // the rollout history; rendering the app-server item would add a bogus
      // "userMessage" tool row.
      return null;
    case 'error':
      return {
        ...base,
        itemType: 'error',
        message: { role: 'error', content: item.message || 'Unknown error' },
      };
    default:
      return {
        ...base,
        itemType: item.type || 'Unknown',
        item,
        status: item.status,
      };
  }
}
