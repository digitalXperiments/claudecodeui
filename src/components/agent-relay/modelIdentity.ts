import type { AgentRelayJob } from './types';

type RelayModelIdentity = Pick<
  AgentRelayJob,
  | 'model'
  | 'model_label'
  | 'catalog_resolved_model'
  | 'runtime_resolved_model'
  | 'model_selection_source'
>;

/**
 * Format the durable Relay model snapshot without pretending that a legacy
 * null meant any particular provider default.
 */
export function formatAgentRelayModelIdentity(job: RelayModelIdentity): string {
  if (!job.model_selection_source) {
    return job.model
      ? `${job.model} (legacy selection)`
      : 'Legacy default (model not recorded)';
  }

  const selected = job.model || 'unknown selection';
  const resolved = job.runtime_resolved_model || job.catalog_resolved_model;
  const identity = resolved && resolved !== selected
    ? `${selected} → ${resolved}`
    : selected;
  const label = job.model_label?.trim();
  return label && label !== selected && label !== resolved
    ? `${label} (${identity})`
    : identity;
}
