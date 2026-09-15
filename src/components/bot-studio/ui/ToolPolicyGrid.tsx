import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';

export type ToolPolicy = 'allow' | 'ask' | 'deny';
export default function ToolPolicyGrid({ server, tools, policy, onChange }: { server: string; tools: Array<{ name: string; description?: string }>; policy: Record<string, ToolPolicy>; onChange: (tool: string, value: ToolPolicy) => void }) {
  const [open, setOpen] = useState(true);
  return <div className="rounded-xl border border-border/70 bg-card/60"><button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open ? '' : '-rotate-90')} />{server}<span className="ml-auto text-[10px] font-normal text-muted-foreground">{tools.length} tools</span></button>{open ? <div className="divide-y divide-border/50 border-t border-border/60">{tools.map((tool) => <div key={tool.name} className="flex items-center gap-3 px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate font-mono text-[11px]">{tool.name}</p>{tool.description ? <p className="truncate text-[10px] text-muted-foreground">{tool.description}</p> : null}</div><select aria-label={`${server} ${tool.name} policy`} value={policy[tool.name] ?? 'ask'} onChange={(event) => onChange(tool.name, event.target.value as ToolPolicy)} className="rounded-md border border-border bg-background px-2 py-1 text-[10px] focus:border-primary focus:outline-none">{(['allow', 'ask', 'deny'] as ToolPolicy[]).map((choice) => <option key={choice}>{choice}</option>)}</select></div>)}</div> : null}</div>;
}
