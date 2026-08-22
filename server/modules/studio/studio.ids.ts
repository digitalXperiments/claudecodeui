import { ulid } from '@/shared/ids.js';

export function newStudioVersionId(): string {
  return `ver_${ulid()}`;
}

export function newStudioVariantId(): string {
  return `var_${ulid()}`;
}
