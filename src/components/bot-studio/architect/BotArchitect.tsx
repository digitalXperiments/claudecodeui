import type { JSX } from 'react';

import type { CreateMcSectionInput, McSection } from '../../mission-control/api/missionControlApi';

export interface BotArchitectProps {
  mode: 'create' | 'edit';
  initialSection?: Partial<CreateMcSectionInput> & { section_id?: string };
  projects: Array<{ id: string; name: string; path: string }>;
  onSaved: (section: McSection) => void;
  onCancel: () => void;
}

/** Temporary merge-safe contract implementation; the architect worker replaces this surface. */
export default function BotArchitect(props: BotArchitectProps): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center"><p className="text-sm font-semibold">Bot Architect</p><p className="max-w-sm text-xs text-muted-foreground">The architect workspace is being connected. Choose Back to return to Bot Studio.</p><button type="button" onClick={props.onCancel} className="rounded-lg border border-border px-3 py-2 text-xs font-medium">Back to Bot Studio</button></div>;
}
