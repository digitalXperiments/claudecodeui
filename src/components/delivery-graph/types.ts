export type DeliveryGraphTask = {
  tempId: string;
  title: string;
  description: string;
  prompt: string;
  reqIds: string[];
  acceptanceIds: string[];
  dependsOn: string[];
  assigneeProvider?: string;
  reviewProvider?: string;
  suggestedBranch?: string;
  labels?: string[];
};

export type DeliveryGraph = {
  version: 1;
  prdPath: string;
  title: string;
  requirements: Array<{ id: string; text: string; priority?: number }>;
  acceptanceCriteria: Array<{ id: string; text: string; reqIds?: string[] }>;
  tasks: DeliveryGraphTask[];
  schedule?: { start?: string; strategy?: 'asap' | 'sequential' };
  mcps?: string[];
  skills?: string[];
};
