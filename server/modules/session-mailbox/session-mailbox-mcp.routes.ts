import express from 'express';

import { sessionMailboxService } from '@/modules/session-mailbox/session-mailbox.service.js';
import { AppError } from '@/shared/utils.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

router.use((req, res, next) => {
  const expected = sessionMailboxService.getMcpToken();
  const token = readBearerToken(req.headers.authorization)
    || String(req.headers['x-session-mailbox-mcp-token'] || '');
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid Session Mailbox MCP token.' });
    return;
  }
  next();
});

/**
 * Caller identity comes from the CLOUDCLI_SESSION_ID env var the MCP stdio
 * process was started with (see session-mailbox-mcp.ts), forwarded as a
 * header on every request — never as a client-suppliable body field, so a
 * session cannot impersonate another one by passing a different id.
 */
function readCallerSessionId(req: express.Request): string {
  const sessionId = String(req.headers['x-session-mailbox-session-id'] || '').trim();
  if (!sessionId) {
    throw new AppError(
      'CLOUDCLI_SESSION_ID was not provided to the session-mailbox MCP server.',
      { code: 'SESSION_IDENTITY_MISSING', statusCode: 400 },
    );
  }
  return sessionId;
}

router.post('/tools/:toolName', async (req, res) => {
  try {
    const callerSessionId = readCallerSessionId(req);
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const toolName = req.params.toolName;
    let result: unknown;

    switch (toolName) {
      case 'list_peer_sessions':
        result = sessionMailboxService.listPeerSessions(callerSessionId);
        break;
      case 'send_peer_message':
        result = await sessionMailboxService.sendPeerMessage({
          fromSessionId: callerSessionId,
          toSessionId: String(input.sessionId || ''),
          message: String(input.message || ''),
          waitMs: typeof input.waitMs === 'number' ? input.waitMs : undefined,
        });
        break;
      case 'check_peer_inbox':
        result = sessionMailboxService.checkPeerInbox(callerSessionId);
        break;
      case 'reply_to_peer':
        result = await sessionMailboxService.replyToPeer({
          fromSessionId: callerSessionId,
          messageId: String(input.messageId || ''),
          message: String(input.message || ''),
          waitMs: typeof input.waitMs === 'number' ? input.waitMs : undefined,
        });
        break;
      default:
        res.status(404).json({ success: false, error: `Unknown Session Mailbox MCP tool "${toolName}".` });
        return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    const statusCode = error instanceof AppError ? error.statusCode : 400;
    res.status(statusCode).json({
      success: false,
      error: error instanceof Error ? error.message : 'Session Mailbox MCP tool failed.',
    });
  }
});

export default router;
