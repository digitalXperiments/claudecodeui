export type StudioPrototypeStatus = 'draft' | 'generating' | 'ready' | 'failed';

export type StudioPrototype = {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  skills: string[];
  status: StudioPrototypeStatus;
  relativeDir: string;
  htmlRelativePath: string;
  notesRelativePath: string;
  handoffRelativePath: string;
  swarmId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StudioPrototypeDetail = StudioPrototype & {
  html: string;
  notes: string;
  handoff: string;
};

export type StudioSeatProfile = {
  id: 'architect' | 'builder' | 'reviewer';
  enabled: boolean;
  label: string;
  kind: 'orchestrator' | 'implementer' | 'reviewer';
  provider: string;
  model: string | null;
  effort: string;
  permissionMode: string;
  focus: string;
};
