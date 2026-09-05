import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import { projectsDb } from '@/modules/database/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';

import { CaptureValidationError, buildCaptureDescription, storeCaptureScreenshot, validateBrowserCapture } from './browser-capture.service.js';

const router = express.Router();

router.use((req, res, next) => {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > 12 * 1024 * 1024) return res.status(413).json({ error: 'Capture payload exceeds 12 MB' });
  next();
});

router.post('/', asyncHandler(async (req, res) => {
  let capture;
  try { capture = validateBrowserCapture(req.body); } catch (error) {
    if (error instanceof CaptureValidationError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    throw error;
  }
  if (!projectsDb.getProjectById(capture.projectId)) throw new AppError('Project not found', { code: 'BROWSER_CAPTURE_PROJECT_NOT_FOUND', statusCode: 404 });
  const board = kanbanDb.getOrCreateGlobalBoard();
  const evidence = capture.screenshot ? await storeCaptureScreenshot(capture.screenshot) : undefined;
  const task = kanbanDb.createTask({
    boardId: board.board_id,
    projectId: capture.projectId,
    title: capture.title,
    description: buildCaptureDescription(capture, evidence),
    prompt: capture.expectedBehavior || `Fix the issue captured at ${capture.url}. Review the attached evidence and reproduce the behavior safely.`,
  });
  res.status(201).json({ success: true, task, evidence: evidence ? { filename: evidence.filename, mimeType: evidence.mimeType } : null });
}));

export default router;
