/**
 * Draft autosave format. Flag off, or editing: exactly the section form as JSON, as it has always
 * been. Runtime wizard: an envelope `{ v: 2, form, runtime }`. Parsing accepts both, so a draft saved
 * before runtime v2 (or with the flag off) restores into the new wizard with default runtime choices,
 * and a v2 draft restores into the classic wizard by dropping the runtime part.
 */

import { emptyRuntimeDraft, normalizeRuntimeDraft, type RuntimeDraft } from './runtimeDraft';
import type { CreateMcSectionInput } from './types';

export type StoredDraft = { form: CreateMcSectionInput; runtime: RuntimeDraft };

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `runtime` null = the classic wizard: store the bare form, byte-compatible with the old format. */
export function serializeDraft(form: CreateMcSectionInput, runtime: RuntimeDraft | null): string {
  return runtime ? JSON.stringify({ v: 2, form, runtime }) : JSON.stringify(form);
}

/** Null when the text is not a usable draft. Never throws. */
export function parseDraft(textValue: string): StoredDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.v === 2 && isObject(parsed.form)) {
    return { form: parsed.form as unknown as CreateMcSectionInput, runtime: normalizeRuntimeDraft(parsed.runtime) };
  }
  return { form: parsed as unknown as CreateMcSectionInput, runtime: emptyRuntimeDraft() };
}

/** True when the stored text is just the untouched starting point (no recoverable work). */
export function isPristineDraft(stored: string, initialForm: CreateMcSectionInput, runtimeWizard: boolean): boolean {
  if (stored === serializeDraft(initialForm, runtimeWizard ? emptyRuntimeDraft() : null)) return true;
  const parsed = parseDraft(stored);
  if (!parsed) return false;
  // A draft written by the other wizard flavour for the same untouched state is still pristine.
  return JSON.stringify(parsed.form) === JSON.stringify(initialForm)
    && (!runtimeWizard || JSON.stringify(parsed.runtime) === JSON.stringify(emptyRuntimeDraft()));
}
