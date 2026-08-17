import { AlertTriangle, Check, Clock3, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../../shared/view/ui';
import { interruptsApi } from '../api/interruptsApi';
import type { Interrupt } from '../types';

function openHrefTarget(href: string | null | undefined): void {
  if (!href) return;
  if (href.startsWith('settings:')) {
    window.dispatchEvent(
      new CustomEvent('cloudcli:open-settings', {
        detail: { tab: href.slice('settings:'.length) || 'agents' },
      }),
    );
    return;
  }
  if (href.startsWith('/settings')) {
    try {
      const url = new URL(href, window.location.origin);
      const tab = url.searchParams.get('tab') || 'agents';
      window.dispatchEvent(
        new CustomEvent('cloudcli:open-settings', {
          detail: { tab },
        }),
      );
      return;
    } catch {
      window.dispatchEvent(
        new CustomEvent('cloudcli:open-settings', { detail: { tab: 'agents' } }),
      );
      return;
    }
  }
  if (href.startsWith('http://') || href.startsWith('https://')) {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

export default function InterruptQueueSection({
  onCountChange,
  onNavigateAway,
}: {
  onCountChange?: (count: number) => void;
  /** Called before deep-linking away (e.g. close the notifications drawer). */
  onNavigateAway?: () => void;
}) {
  const [items, setItems] = useState<Interrupt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await interruptsApi.list();
      setItems(next.interrupts);
      onCountChange?.(next.count);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load Needs you queue');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (item: Interrupt, action: string) => {
    try {
      if (action === 'open_href') {
        onNavigateAway?.();
        openHrefTarget(item.href);
      }
      await interruptsApi.action(item.interrupt_id, action);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Interrupt action failed');
    }
  };

  return (
    <section className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-foreground">Waiting for your decision</h3>
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">{items.length}</span>
        </div>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {items.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">Nothing needs your attention right now.</p> : (
        <div className="space-y-2">
          {items.map((item) => (
              <div key={item.interrupt_id} className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="inline text-xs font-semibold text-foreground">{item.title}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{item.body}</p>
                </div>
                <span className="text-[10px] uppercase text-muted-foreground">{item.kind.replace(/_/g, ' ')}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {item.actions.map((action) => (
                  <Button
                    key={action.id}
                    size="sm"
                    variant={action.style === 'destructive' ? 'destructive' : action.style === 'primary' ? 'default' : 'outline'}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => void act(item, action.id)}
                  >
                    {action.id.startsWith('approve') ? <Check /> : action.id.startsWith('deny') ? <X /> : <AlertTriangle />}
                    {action.label}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={async () => { await interruptsApi.snooze(item.interrupt_id); await refresh(); }}><Clock3 /> Snooze</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
