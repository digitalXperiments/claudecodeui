/**
 * Secrets vault REST surface (PRD §8.6, Appendix B: "secrets meta CRUD +
 * resolve internal only"). Mounted by the orchestrator at `/api/secrets`.
 *
 * There is deliberately NO resolve endpoint: plaintext values never cross
 * the HTTP boundary. Every response is `SecretMeta` only.
 */

import express from 'express';

import { secretsService } from '@/modules/secrets/secrets.service.js';
import { isSecretScope, type SecretScope } from '@/modules/secrets/secrets.types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

function readOptionalScope(value: unknown, fieldName: string): SecretScope | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isSecretScope(value)) {
    throw new AppError(`Invalid ${fieldName}: ${String(value)}`, {
      code: 'SECRET_INVALID_SCOPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${fieldName} must be a non-empty string`, {
      code: 'SECRET_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AppError(`${fieldName} must be a string`, {
      code: 'SECRET_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return value;
}

function readPathParam(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

/** GET / — list metadata (?scope=user|project|provider|profile). Never returns values. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = readOptionalScope(req.query.scope, 'scope');
    res.json({ secrets: secretsService.list(scope) });
  }),
);

/** POST / — put (create or rotate) a secret. Body carries the value; the response never does. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = readRequiredString(body.name, 'name');
    const value = readRequiredString(body.value, 'value');
    const scope = readOptionalScope(body.scope, 'scope');
    const scopeRef = readOptionalString(body.scopeRef, 'scopeRef');
    const description = readOptionalString(body.description, 'description');
    const expiresAt = readOptionalString(body.expiresAt, 'expiresAt');
    if (scopeRef !== undefined && scopeRef.trim().length === 0) {
      throw new AppError('scopeRef must be non-empty when provided', {
        code: 'SECRET_INVALID_INPUT',
        statusCode: 400,
      });
    }
    let meta;
    try {
      meta = secretsService.put({ name, value, scope, scopeRef, description, expiresAt });
    } catch (error) {
      if (error instanceof Error && !(error instanceof AppError)) {
        throw new AppError(error.message, { code: 'SECRET_INVALID_INPUT', statusCode: 400 });
      }
      throw error;
    }
    res.status(201).json(meta);
  }),
);

/** GET /:secretId — metadata for one secret (accepts a `sec_…` id or a name). */
router.get(
  '/:secretId',
  asyncHandler(async (req, res) => {
    const scope = readOptionalScope(req.query.scope, 'scope');
    const meta = secretsService.getMeta(readPathParam(req.params.secretId), scope);
    if (!meta) {
      throw new AppError('Secret not found', { code: 'SECRET_NOT_FOUND', statusCode: 404 });
    }
    res.json(meta);
  }),
);

/** DELETE /:secretId — remove a secret by id. */
router.delete(
  '/:secretId',
  asyncHandler(async (req, res) => {
    const meta = secretsService.getMeta(readPathParam(req.params.secretId));
    if (!meta) {
      throw new AppError('Secret not found', { code: 'SECRET_NOT_FOUND', statusCode: 404 });
    }
    secretsService.delete(meta.secret_id);
    res.json({ ok: true });
  }),
);

export default router;
