export type InterruptAction = { id: string; label: string; style?: 'primary' | 'secondary' | 'destructive' };

export type Interrupt = {
  interrupt_id: string;
  project_id: string | null;
  kind: string;
  severity: string;
  title: string;
  body: string;
  run_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  href: string | null;
  actions: InterruptAction[];
  status: string;
  snooze_until: string | null;
  created_at: string;
  meta: Record<string, unknown>;
};

