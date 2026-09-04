import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { ensureScratchRoot } from '@/shared/scratch.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

import {
  ANTIGRAVITY_SETUP_TIMEOUT_MS,
  spawnAntigravityAcpChild,
} from './antigravity-acp.js';

/**
 * Antigravity's model catalog comes from the agent itself — the `model` entry in
 * the `configOptions` that `session/new` returns.
 *
 * There is deliberately **no hardcoded fallback list**. Shipping a guessed set
 * of Gemini model ids would put names in the picker that the installed runtime
 * may reject at `session/set_config_option` time, and the failure would surface
 * mid-turn as an opaque ACP error. An empty catalog reads correctly instead:
 * the picker shows nothing until the runtime is installed and signed in, and
 * the chat runtime simply leaves the agent on its own default model.
 */
const EMPTY_CATALOG: ProviderModelsDefinition = { OPTIONS: [], DEFAULT: '' };

type ConfigOption = {
  id?: unknown;
  configId?: unknown;
  value?: unknown;
  options?: unknown;
};

/** Read the `model` config option out of a `session/new` result. */
export function parseAntigravityModelCatalog(sessionResult: unknown): ProviderModelsDefinition {
  const record = readObjectRecord(sessionResult);
  const configOptions = Array.isArray(record?.configOptions) ? record.configOptions as ConfigOption[] : [];
  const modelOption = configOptions.find((option) => option?.id === 'model' || option?.configId === 'model');
  if (!modelOption || !Array.isArray(modelOption.options)) return EMPTY_CATALOG;

  const options: ProviderModelOption[] = [];
  for (const entry of modelOption.options) {
    if (typeof entry === 'string') {
      if (!options.some((option) => option.value === entry)) options.push({ value: entry, label: entry });
      continue;
    }
    const candidate = readObjectRecord(entry);
    const value = readOptionalString(candidate?.value) ?? readOptionalString(candidate?.id);
    if (!value || options.some((option) => option.value === value)) continue;
    options.push({
      value,
      label: readOptionalString(candidate?.name) ?? readOptionalString(candidate?.label) ?? value,
      description: readOptionalString(candidate?.description),
    });
  }

  if (options.length === 0) return EMPTY_CATALOG;
  const current = readOptionalString(modelOption.value);
  return {
    OPTIONS: options,
    DEFAULT: current && options.some((option) => option.value === current) ? current : options[0].value,
  };
}

export class AntigravityProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    let session;
    try {
      session = spawnAntigravityAcpChild();
    } catch {
      // Not installed / bad override — the auth facet reports why.
      return EMPTY_CATALOG;
    }

    try {
      await session.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'cloudcli', version: '1.0.0' },
      }, ANTIGRAVITY_SETUP_TIMEOUT_MS);

      // A throwaway cwd: the catalog is a property of the agent, not the
      // workspace, and probing inside a user's repo would create session state
      // there. Kept under the repo's scratch root per the temp-file rule.
      const cwd = path.join(await ensureScratchRoot(), 'antigravity');
      const sessionResult = await session.rpc.request('session/new', { cwd, mcpServers: [] }, ANTIGRAVITY_SETUP_TIMEOUT_MS);
      return parseAntigravityModelCatalog(sessionResult);
    } catch {
      return EMPTY_CATALOG;
    } finally {
      session.dispose();
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('antigravity', input);
  }
}
