import type { ProviderModelOption, ProviderModelsDefinition } from '../types/app';

/**
 * A bare run of separator/whitespace characters, or a column-header word —
 * the shape a malformed CLI table row (`omp models` output parsed without
 * stripping headers/dividers) leaks into the catalog as. Defends the picker
 * against a stale or buggy cache even though the source parser is also
 * expected to filter these.
 */
const DECORATIVE_VALUE_PATTERN = /^[\s\-_=|.·•\u2500-\u257f]+$/u;
const HEADER_WORDS = new Set(['provider', 'model', 'context', 'thinking', 'images', 'max-out']);

/** Whether a catalog entry is a real, selectable model rather than a blank/header/separator row. */
export const isValidModelOption = (
  option: Pick<ProviderModelOption, 'value'> | { value: string } | null | undefined,
): boolean => {
  const value = typeof option?.value === 'string' ? option.value.trim() : '';
  if (!value) {
    return false;
  }
  if (DECORATIVE_VALUE_PATTERN.test(value)) {
    return false;
  }
  if (HEADER_WORDS.has(value.toLowerCase())) {
    return false;
  }
  return true;
};

/** Filters a raw options list down to entries {@link isValidModelOption} accepts. */
export const filterValidModelOptions = <T extends { value: string }>(
  options: readonly T[] | undefined | null,
): T[] => (options ?? []).filter((option) => isValidModelOption(option));

/**
 * Finds the catalog entry for one model identifier.
 *
 * A model can reach the UI either as the provider alias the user picked
 * (`opus[1m]`) or as the concrete id the CLI resolved it to and wrote into the
 * session log (`claude-opus-5[1m]`). Matching only on `value` makes the second
 * form fall through and render a raw model id in the composer, so resolved ids
 * are accepted too.
 */
export const findProviderModelOption = (
  definition: ProviderModelsDefinition | undefined | null,
  model: string | undefined | null,
): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!definition || !normalizedModel) {
    return null;
  }

  const validOptions = filterValidModelOptions(definition.OPTIONS);
  return validOptions.find((option) => option.value === normalizedModel)
    ?? validOptions.find((option) => option.resolvedModel === normalizedModel)
    ?? null;
};

/**
 * Whether `model` refers to the same model as `option`, by alias or resolved id.
 */
export const isProviderModelMatch = (
  option: Pick<ProviderModelOption, 'value' | 'resolvedModel'>,
  model: string | undefined | null,
): boolean => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return false;
  }

  return option.value === normalizedModel || option.resolvedModel === normalizedModel;
};

/**
 * Human-readable label for a model, falling back to the raw identifier when the
 * catalog has no matching entry (an unknown or newly released model).
 */
export const resolveProviderModelLabel = (
  definition: ProviderModelsDefinition | undefined | null,
  model: string | undefined | null,
): string | null => {
  const option = findProviderModelOption(definition, model);
  if (option) {
    return option.label;
  }

  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  return normalizedModel || null;
};
