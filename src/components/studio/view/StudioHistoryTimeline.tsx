import { Undo2 } from 'lucide-react';

import { Badge, Button, ScrollArea } from '../../../shared/view/ui';
import type { StudioVersionDetail, StudioVersionKind } from '../types';

type StudioHistoryTimelineProps = {
  versions: StudioVersionDetail[];
  activeVersionId: string;
  busy?: boolean;
  onRevert: (versionId: string) => void;
};

const KIND_LABEL: Record<StudioVersionKind, string> = {
  initial: 'Brief',
  turn: 'Turn',
  'variant-promotion': 'Promotion',
  revert: 'Revert',
};

export default function StudioHistoryTimeline({
  versions,
  activeVersionId,
  busy = false,
  onRevert,
}: StudioHistoryTimelineProps) {
  const ordered = [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section className="flex min-h-0 flex-col" data-studio-pane="history">
      <div className="border-b border-border px-4 py-2">
        <h2 className="text-sm font-medium">Version history</h2>
        <p className="text-xs text-muted-foreground">Revert restores that preview as the parent of the next turn.</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="space-y-2 p-3">
          {ordered.map((version, index) => {
            const active = version.id === activeVersionId;
            return (
              <li
                key={version.id}
                className={`rounded-md border px-3 py-2 ${active ? 'border-primary bg-primary/5' : 'border-border'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{index + 1}</span>
                    <Badge variant={version.kind === 'variant-promotion' ? 'default' : 'secondary'}>
                      {KIND_LABEL[version.kind]}
                    </Badge>
                    {active ? <span className="text-[11px] font-medium text-primary">Active</span> : null}
                  </div>
                  <time className="text-[11px] text-muted-foreground">
                    {new Date(version.createdAt).toLocaleTimeString()}
                  </time>
                </div>
                <p className="mt-1 line-clamp-3 text-sm">{version.message}</p>
                {!active ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2 h-7 px-2"
                    disabled={busy}
                    onClick={() => onRevert(version.id)}
                  >
                    <Undo2 className="mr-1 h-3.5 w-3.5" />
                    Revert to here
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </section>
  );
}
