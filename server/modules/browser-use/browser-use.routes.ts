import express from 'express';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';

const router = express.Router();

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

router.get('/status', async (_req, res) => {
  try {
    res.json({ success: true, data: await browserUseService.getStatus() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Browser status.',
    });
  }
});

router.get('/settings', async (_req, res) => {
  try {
    res.json({ success: true, data: { settings: await browserUseService.getSettings() } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Browser settings.',
    });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const settings = await browserUseService.updateSettings(req.body || {});
    res.json({ success: true, data: { settings } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Browser settings.',
    });
  }
});

router.post('/runtime/install', async (_req, res) => {
  try {
    const result = await browserUseService.installRuntime();
    res.status(result.success ? 200 : 500).json({
      success: result.success,
      data: result,
      error: result.success ? undefined : result.message,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install Browser runtime.',
    });
  }
});

// Human-in-the-loop browser prompts are intentionally kept in memory. The
// browser panel polls this route and posts an answer while the MCP tool call
// remains blocked on the server-side prompt promise.
router.get('/prompts', (_req, res) => {
  try {
    res.json({ success: true, data: { prompts: browserUseService.listPendingPrompts() } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load browser prompts.',
    });
  }
});

router.post('/prompts/:promptId/answer', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const answer = typeof body.answer === 'string'
      ? body.answer
      : typeof body.value === 'string'
        ? body.value
        : '';
    const result = browserUseService.answerPrompt(readParam(req.params.promptId), answer);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to answer browser prompt.',
    });
  }
});

router.get('/sessions', async (_req, res) => {
  try {
    res.json({ success: true, data: { sessions: await browserUseService.listSessions() } });
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list browser sessions.',
    });
  }
});

router.post('/sessions/:sessionId/control', async (req, res) => {
  try {
    const sessionId = readParam(req.params.sessionId);
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    if (body.action === 'take') {
      res.json({ success: true, data: { session: await browserUseService.takeHumanControl(sessionId) } });
      return;
    }
    if (body.action === 'return') {
      res.json({ success: true, data: { session: await browserUseService.returnAgentControl(sessionId) } });
      return;
    }
    const action = body.action;
    if (action !== 'click' && action !== 'type' && action !== 'key' && action !== 'scroll' && action !== 'navigate') {
      throw new Error('action must be take, return, click, type, key, scroll, or navigate.');
    }
    const result = await browserUseService.humanInput(sessionId, {
      action: action as 'click' | 'type' | 'key' | 'scroll' | 'navigate',
      x: typeof body.x === 'number' ? body.x : undefined,
      y: typeof body.y === 'number' ? body.y : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      key: typeof body.key === 'string' ? body.key : undefined,
      deltaX: typeof body.deltaX === 'number' ? body.deltaX : undefined,
      deltaY: typeof body.deltaY === 'number' ? body.deltaY : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
      secret: body.secret === true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Browser control failed.' });
  }
});

router.post('/sessions/:sessionId/stop', async (req, res) => {
  try {
    const result = await browserUseService.stopSession(readParam(req.params.sessionId));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop browser session.',
    });
  }
});

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const result = await browserUseService.deleteSession(readParam(req.params.sessionId));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete browser session.',
    });
  }
});

export default router;
