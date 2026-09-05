import { ulid } from '@/shared/ids.js';

export function newStudioVersionId(): string {
  return `ver_${ulid()}`;
}

export function newStudioVariantId(): string {
  return `var_${ulid()}`;
}

export function newStudioUniverseId(): string {
  return `uni_${ulid()}`;
}

export function newStudioUniverseVariantId(): string {
  return `uv_${ulid()}`;
}
