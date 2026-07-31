import type { ProviderModelOption, ProviderModelsDefinition } from '../types/app';

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

  return definition.OPTIONS.find((option) => option.value === normalizedModel)
    ?? definition.OPTIONS.find((option) => option.resolvedModel === normalizedModel)
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
