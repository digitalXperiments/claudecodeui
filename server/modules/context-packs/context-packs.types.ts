export type ContextPackItemKind = 'file' | 'memory' | 'run_summary' | 'task' | 'diff' | 'adr';

export type ContextPackItem = {
  kind: ContextPackItemKind;
  uri: string;
  title: string;
  excerpt: string;
  score: number;
  freshAt?: string;
};

export type ContextPack = {
  pack_id: string;
  project_id: string;
  goal: string;
  budgetTokens: number;
  estimatedTokens: number;
  items: ContextPackItem[];
  warnings: string[];
  markdown: string;
  created_at: string;
};

export type ContextPackAttachment = {
  attachment_id: string;
  pack_id: string;
  run_id: string | null;
  session_id: string | null;
  created_at: string;
};
