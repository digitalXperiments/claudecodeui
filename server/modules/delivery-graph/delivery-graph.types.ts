import type { LLMProvider } from '@/shared/types.js';

export type DeliveryGraphRequirement = {
  id: string;
  text: string;
  priority?: number;
};

export type DeliveryGraphAcceptanceCriterion = {
  id: string;
  text: string;
  reqIds?: string[];
};

export type DeliveryGraphTask = {
  tempId: string;
  title: string;
  description: string;
  prompt: string;
  reqIds: string[];
  acceptanceIds: string[];
  dependsOn: string[];
  estimateMinutes?: number;
  assigneeProvider?: LLMProvider | string;
  reviewProvider?: LLMProvider | string;
  implementProfileId?: string;
  reviewProfileId?: string;
  permissionMode?: string;
  suggestedBranch?: string;
  labels?: string[];
};

export type DeliveryGraph = {
  version: 1;
  prdPath: string;
  title: string;
  requirements: DeliveryGraphRequirement[];
  acceptanceCriteria: DeliveryGraphAcceptanceCriterion[];
  tasks: DeliveryGraphTask[];
  schedule?: { start?: string; strategy?: 'asap' | 'sequential' };
  mcps?: string[];
  skills?: string[];
};

export type DeliveryGraphApplyResult = {
  boardId: string;
  created: Array<{ tempId: string; taskId: string; title: string }>;
  reused: Array<{ tempId: string; taskId: string; title: string }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  queued: string[];
  warnings: string[];
};

export type TaskMasterImportItem = {
  id: string | number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  details?: string;
  testStrategy?: string;
  parentId?: string | number;
  dependencies?: Array<string | number>;
  subtasks?: TaskMasterImportItem[];
  [key: string]: unknown;
};

export type TaskMasterImportReport = {
  projectId: string;
  boardId: string;
  sourcePath: string;
  dryRun: boolean;
  total: number;
  wouldCreate: number;
  created: Array<{ sourceId: string; taskId?: string; title: string }>;
  existing: Array<{ sourceId: string; taskId: string; title: string }>;
  dependencies: Array<{ sourceId: string; dependsOnSourceId: string; taskId?: string; dependsOnTaskId?: string }>;
  dependencyWarnings: string[];
  warnings: string[];
};
