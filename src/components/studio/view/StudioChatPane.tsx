import type { FormEvent } from 'react';
import { Layers, Loader2, SendHorizonal, X } from 'lucide-react';

import { Badge, Button, ScrollArea } from '../../../shared/view/ui';
import { formatSelectedElement } from '../preview/selectBridge';
import type {
  StudioGenerationProgress,
  StudioPrototypeStatus,
  StudioSelectedElement,
  StudioVersionDetail,
  StudioVersionKind,
} from '../types';

type StudioChatPaneProps = {
  versions: StudioVersionDetail[];
  status: StudioPrototypeStatus;
  generation: StudioGenerationProgress | null;
  draft: string;
  selection: StudioSelectedElement | null;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onRequestVariants: () => void;
  onClearSelection: () => void;
};

const KIND_LABEL: Record<StudioVersionKind, string> = {
  initial: 'Brief',
  turn: 'Refinement',
  'variant-promotion': 'Variant',
  revert: 'Revert',
};

function generationLabel(
  status: StudioPrototypeStatus,
  generation: StudioGenerationProgress | null,
): string | null {
  if (status === 'failed' && generation?.error) {
    return generation.error;
  }
  if (status !== 'generating' || !generation) return null;
  const kind =
    generation.kind === 'turn' ? 'Refining prototype'
    : generation.kind === 'variants' ? 'Generating variants'
    : generation.kind === 'tokens' ? 'Applying design tokens'
    : 'Design swarm running';
  return generation.message ? `${kind} — ${generation.message}` : kind;
}

export default function StudioChatPane({
  versions,
  status,
  generation,
  draft,
  selection,
  busy,
  onDraftChange,
  onSubmit,
  onRequestVariants,
  onClearSelection,
}: StudioChatPaneProps) {
  const progress = generationLabel(status, generation);
  const turns = [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const generating = status === 'generating';

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r" data-studio-pane="chat">
      <div className="border-b border-border px-4 py-2">
        <h2 className="text-sm font-medium">Refinement</h2>
        <p className="text-xs text-muted-foreground">Each turn edits the live prototype instead of starting over.</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="space-y-3 p-4">
          {turns.map((version) => (
            <li key={version.id} className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="mb-1 flex items-center gap-2">
                <Badge variant="secondary">{KIND_LABEL[version.kind]}</Badge>
                <time className="text-[11px] text-muted-foreground">
                  {new Date(version.createdAt).toLocaleTimeString()}
                </time>
              </div>
              <p className="whitespace-pre-wrap text-sm">{version.message}</p>
              {version.selectedElement ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Target {formatSelectedElement(version.selectedElement)}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </ScrollArea>
      <div className="border-t border-border p-3">
        {progress ? (
          <p className={`mb-2 flex items-center gap-2 text-xs ${status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {progress}
          </p>
        ) : null}
        {selection ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs">
            <span>
              Targeting {formatSelectedElement(selection)}
              {selection.path ? ` · ${selection.path}` : ''}
            </span>
            <button type="button" onClick={onClearSelection} aria-label="Clear selected element">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={selection ? 'Describe how this element should change…' : 'Describe the next change…'}
            className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            disabled={busy || generating}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || generating || !draft.trim()}>
              <SendHorizonal className="mr-1 h-3.5 w-3.5" />
              Send
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onRequestVariants}
              disabled={busy || generating}
            >
              <Layers className="mr-1 h-3.5 w-3.5" />
              Request variants
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
