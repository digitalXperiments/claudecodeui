import { Collapsible, CollapsibleContent, CollapsibleTrigger, ScrollArea } from '../../../shared/view/ui';

type StudioArtifactsProps = {
  notes: string;
  handoff: string;
};

export default function StudioArtifacts({ notes, handoff }: StudioArtifactsProps) {
  return (
    <section className="border-t border-border" data-studio-pane="artifacts">
      <Collapsible defaultOpen={false}>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-medium">
          Notes & handoff
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ScrollArea className="max-h-64">
            <div className="space-y-3 p-4">
              <article>
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</h3>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-foreground">{notes || 'No notes yet.'}</pre>
              </article>
              <article>
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Handoff</h3>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-foreground">{handoff || 'No handoff yet.'}</pre>
              </article>
            </div>
          </ScrollArea>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
