import { Check } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { injectSelectBridge } from '../preview/selectBridge';
import type { StudioVariant } from '../types';

type StudioVariantStripProps = {
  variants: StudioVariant[];
  generating?: boolean;
  busy?: boolean;
  onPromote: (variantId: string) => void;
};

export default function StudioVariantStrip({
  variants,
  generating = false,
  busy = false,
  onPromote,
}: StudioVariantStripProps) {
  if (!generating && variants.length === 0) return null;

  return (
    <div className="border-t border-border bg-background" data-studio-pane="variants">
      <div className="flex items-center justify-between px-4 py-2">
        <h2 className="text-sm font-medium">Variants</h2>
        <p className="text-xs text-muted-foreground">
          {generating ? 'Generating distinct directions…' : 'Pick one to make it the active version.'}
        </p>
      </div>
      <div className="flex gap-3 overflow-x-auto px-4 pb-4">
        {variants.map((variant) => (
          <article
            key={variant.id}
            className="w-[280px] shrink-0 overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="h-40 overflow-hidden bg-white">
              <iframe
                title={variant.label}
                sandbox="allow-scripts allow-forms"
                className="h-[200%] w-[200%] origin-top-left scale-50 border-0"
                srcDoc={injectSelectBridge(variant.html)}
              />
            </div>
            <div className="space-y-2 p-3">
              <div className="text-sm font-medium">{variant.label}</div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{variant.direction}</p>
              <Button
                size="sm"
                className="w-full"
                disabled={busy || generating}
                onClick={() => onPromote(variant.id)}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Use this one
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
