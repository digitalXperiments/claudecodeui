import type { LLMProvider } from '@/shared/types.js';

export type FailoverErrorClass = 'auth' | 'rate_limit' | 'timeout' | 'mcp_unhealthy' | 'any';

export type FailoverMatch = {
  providers?: string[];
  errors?: FailoverErrorClass[];
};

export type FailoverCandidate = {
  provider: LLMProvider | string;
  model?: string | null;
  profileId?: string | null;
};

export type FailoverStrategy = {
  candidates: FailoverCandidate[];
  handoffMode: 'summary' | 'full' | 'fresh';
  attachContextPack?: boolean;
  maxFailovers: number;
};

export type FailoverApproval = 'auto' | 'interrupt';

export type FailoverPlaybook = {
  playbook_id: string;
  name: string;
  project_id: string | null;
  enabled: boolean;
  match: FailoverMatch;
  strategy: FailoverStrategy;
  approval: FailoverApproval;
  created_at: string;
  updated_at: string;
};

export type CreateFailoverPlaybookInput = {
  name: string;
  projectId?: string | null;
  enabled?: boolean;
  match?: FailoverMatch;
  strategy: FailoverStrategy;
  approval?: FailoverApproval;
};

export type UpdateFailoverPlaybookInput = Partial<CreateFailoverPlaybookInput>;

export type FailoverTriggerOptions = {
  playbookId?: string;
  approved?: boolean;
};

export type FailoverResult = {
  status: 'started' | 'approval_pending';
  playbook: FailoverPlaybook;
  parentRunId: string;
  childRunId?: string;
  interruptId?: string;
  candidate?: FailoverCandidate;
  handoffPrompt?: string | null;
  warning?: string;
};
