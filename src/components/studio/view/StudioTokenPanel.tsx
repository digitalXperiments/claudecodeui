import { useEffect, useMemo, useState } from 'react';
import { Palette } from 'lucide-react';

import { Button, Input, ScrollArea } from '../../../shared/view/ui';
import type { StudioDesignTokens, StudioTokensPatch } from '../types';

type StudioTokenPanelProps = {
  tokens: StudioDesignTokens;
  busy?: boolean;
  onApply: (tokens: StudioTokensPatch) => void;
};

const COLOR_FIELDS: Array<{ key: keyof StudioDesignTokens['colors']; label: string }> = [
  { key: 'background', label: 'Background' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'muted', label: 'Muted' },
  { key: 'accent', label: 'Accent' },
  { key: 'accentForeground', label: 'Accent text' },
  { key: 'card', label: 'Card' },
  { key: 'border', label: 'Border' },
  { key: 'wash', label: 'Wash' },
];

function cloneTokens(tokens: StudioDesignTokens): StudioDesignTokens {
  return structuredClone(tokens);
}

export default function StudioTokenPanel({ tokens, busy = false, onApply }: StudioTokenPanelProps) {
  const [draft, setDraft] = useState<StudioDesignTokens>(() => cloneTokens(tokens));
  const snapshot = useMemo(() => JSON.stringify(tokens), [tokens]);

  useEffect(() => {
    setDraft(JSON.parse(snapshot) as StudioDesignTokens);
  }, [snapshot]);

  const dirty = JSON.stringify(draft) !== snapshot;

  const apply = () => {
    onApply({
      colors: draft.colors,
      typography: draft.typography,
      spacing: draft.spacing,
      radii: draft.radii,
    });
  };

  return (
    <section className="flex min-h-0 flex-col border-t border-border" data-studio-pane="tokens">
      <div className="border-b border-border px-4 py-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Palette className="h-3.5 w-3.5" />
          Design tokens
        </h2>
        <p className="text-xs text-muted-foreground">Edits persist on the prototype and regenerate the active version.</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Colors</legend>
            {COLOR_FIELDS.map((field) => (
              <label key={field.key} className="flex items-center justify-between gap-2 text-xs">
                <span>{field.label}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={field.label}
                    value={draft.colors[field.key]}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((current) => ({
                        ...current,
                        colors: { ...current.colors, [field.key]: value },
                      }));
                    }}
                    className="h-7 w-9 cursor-pointer rounded border border-border bg-background"
                  />
                  <Input
                    value={draft.colors[field.key]}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((current) => ({
                        ...current,
                        colors: { ...current.colors, [field.key]: value },
                      }));
                    }}
                    className="h-7 w-24 px-2 text-xs"
                  />
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Typography</legend>
            <label className="block text-xs">
              Body font
              <Input
                value={draft.typography.fontFamily}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  typography: { ...current.typography, fontFamily: event.target.value },
                }))}
                className="mt-1 h-8"
              />
            </label>
            <label className="block text-xs">
              Heading font
              <Input
                value={draft.typography.headingFamily}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  typography: { ...current.typography, headingFamily: event.target.value },
                }))}
                className="mt-1 h-8"
              />
            </label>
            <label className="block text-xs">
              Base size (px)
              <Input
                type="number"
                value={draft.typography.baseSizePx}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  typography: { ...current.typography, baseSizePx: Number(event.target.value) },
                }))}
                className="mt-1 h-8"
              />
            </label>
            <label className="block text-xs">
              Line height
              <Input
                type="number"
                step="0.05"
                value={draft.typography.lineHeight}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  typography: { ...current.typography, lineHeight: Number(event.target.value) },
                }))}
                className="mt-1 h-8"
              />
            </label>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Spacing</legend>
            <label className="block text-xs">
              Unit (px)
              <Input
                type="number"
                value={draft.spacing.unitPx}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  spacing: { ...current.spacing, unitPx: Number(event.target.value) },
                }))}
                className="mt-1 h-8"
              />
            </label>
            <label className="block text-xs">
              Section gap (px)
              <Input
                type="number"
                value={draft.spacing.sectionGapPx}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  spacing: { ...current.spacing, sectionGapPx: Number(event.target.value) },
                }))}
                className="mt-1 h-8"
              />
            </label>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Radii</legend>
            {([
              ['smPx', 'Small'],
              ['mdPx', 'Medium'],
              ['lgPx', 'Large'],
              ['pillPx', 'Pill'],
            ] as const).map(([key, label]) => (
              <label key={key} className="block text-xs">
                {label} (px)
                <Input
                  type="number"
                  value={draft.radii[key]}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    radii: { ...current.radii, [key]: Number(event.target.value) },
                  }))}
                  className="mt-1 h-8"
                />
              </label>
            ))}
          </fieldset>
        </div>
      </ScrollArea>
      <div className="border-t border-border p-3">
        <Button size="sm" className="w-full" disabled={busy || !dirty} onClick={apply}>
          Apply tokens
        </Button>
      </div>
    </section>
  );
}
