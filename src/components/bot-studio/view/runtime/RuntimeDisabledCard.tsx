import { Sparkles } from 'lucide-react';

/** Shown instead of a runtime page (Brief/Channels/Teams) while Bot runtime v2 is off. */
export default function RuntimeDisabledCard({ pageLabel }: { pageLabel: string }) {
  return <section className="flex min-h-0 flex-1 items-center justify-center p-6">
    <div className="max-w-sm rounded-xl border border-border/70 bg-card p-6 text-center">
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Sparkles className="h-4 w-4" /></span>
      <p className="mt-3 text-sm font-semibold">{pageLabel} needs Bot runtime v2</p>
      <p className="mt-1 text-xs text-muted-foreground">Enable Bot runtime v2 in Settings → Appearance to use this page.</p>
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('cloudcli:open-settings', { detail: { tab: 'appearance' } }))} className="mt-4 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open Settings → Appearance</button>
    </div>
  </section>;
}
