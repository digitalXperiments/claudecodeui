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

export type CreateStudioPrototypeInput = {
  projectId: string;
  title?: string;
  brief: string;
  skills?: string[];
};

export type UpdateStudioPrototypeInput = {
  title?: string;
  brief?: string;
  skills?: string[];
  html?: string;
  notes?: string;
  handoff?: string;
  status?: StudioPrototypeStatus;
  swarmId?: string | null;
};

export type LaunchStudioSwarmInput = {
  projectId: string;
  prototypeId: string;
};
