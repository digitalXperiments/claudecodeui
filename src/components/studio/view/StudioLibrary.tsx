import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import type { StudioPrototype, StudioPrototypeDetail } from '../types';

type StudioLibraryProps = {
  items: StudioPrototype[];
  activeId: string | null;
  busy: boolean;
  onCreate: (input: { brief: string; skills?: string[] }) => Promise<StudioPrototypeDetail | null>;
  onSelect: (item: StudioPrototype) => void;
  onDelete: (item: StudioPrototype) => void;
};

export default function StudioLibrary({
  items,
  activeId,
  busy,
  onCreate,
  onSelect,
  onDelete,
}: StudioLibraryProps) {
  const [brief, setBrief] = useState('');
  const [skills, setSkills] = useState('');

  const handleCreate = async () => {
    const created = await onCreate({
      brief,
      skills: skills.split(',').map((part) => part.trim()).filter(Boolean),
    });
    if (created) {
      setBrief('');
    }
  };

  return (
    <aside className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
      <div className="space-y-3 p-4">
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="Landing page for a prawn-farm monitor: live pond telemetry, alerts, and a walkthrough request."
          className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <input
          value={skills}
          onChange={(event) => setSkills(event.target.value)}
          placeholder="Optional skills, comma-separated"
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        />
        <Button size="sm" onClick={() => void handleCreate()} disabled={busy}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          New prototype
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {items.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No prototypes in this project yet.</p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className={`mb-1 flex items-start justify-between rounded-md px-2 py-2 ${
                activeId === item.id ? 'bg-primary/10' : 'hover:bg-accent/60'
              }`}
            >
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(item)}>
                <div className="truncate text-sm font-medium">{item.title}</div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.status}</div>
              </button>
              <button
                type="button"
                className="p-1 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(item)}
                aria-label="Delete prototype"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
