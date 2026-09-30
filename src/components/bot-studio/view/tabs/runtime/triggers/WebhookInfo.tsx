import { Check, Copy } from 'lucide-react';

import { useCopy } from '../panel/useAsyncAction';

import { SIGNATURE_HEADER_DOC, webhookUrl } from './triggerForm';

/** The endpoint a webhook trigger listens on, with copy and the signing recipe. */
export default function WebhookInfo({ triggerId }: { triggerId: string | null }) {
  const { copied, copy } = useCopy();
  if (!triggerId) {
    return <p className="text-[11px] text-muted-foreground">The endpoint URL (<code className="font-mono">/api/hooks/bots/&lt;triggerId&gt;</code>) is shown as soon as you save.</p>;
  }
  const url = webhookUrl(triggerId, typeof window === 'undefined' ? '' : window.location.origin);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <code aria-label="Webhook endpoint URL" className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px]" title={url}>{url}</code>
        <button type="button" className="button" onClick={() => void copy(url)} aria-label="Copy webhook URL">
          {copied === url ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied === url ? 'Copied' : 'Copy'}
        </button>
      </div>
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium text-foreground">How callers sign requests</summary>
        <p className="mt-1.5 leading-relaxed">{SIGNATURE_HEADER_DOC}</p>
        <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">{`body='{"hello":"world"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST '${url}' \\
  -H 'Content-Type: application/json' \\
  -H "X-Webhook-Signature: sha256=$sig" \\
  -H 'X-Webhook-Id: unique-delivery-id' \\
  -d "$body"`}</pre>
        <p className="mt-1.5">Everything a webhook delivers is treated as untrusted (external) content: the bot reads it, but it cannot authorize risky actions on its own.</p>
      </details>
    </div>
  );
}
