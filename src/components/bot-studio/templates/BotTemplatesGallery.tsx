import { useMemo, useState } from 'react';
import { Check, Search, Sparkles, WandSparkles } from 'lucide-react';

import type { CreateMcSectionInput } from '../architect/types';
import BotIcon from '../ui/BotIcon';

import { BOT_TEMPLATES } from './templates';

export interface BotTemplate {
  key: string;
  name: string;
  icon: string;
  purpose: string;
  category: 'comms' | 'engineering' | 'content' | 'ops';
  requiredMcp: string[];
  section: Partial<CreateMcSectionInput>;
  legacySeed?: boolean;
}
export interface BotTemplatesGalleryProps {
  connectedMcpServers: string[];
  onUse: (template: BotTemplate) => void;
}

const CATEGORIES: Array<{ value: 'all' | BotTemplate['category']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'comms', label: 'Comms' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'content', label: 'Content' },
  { value: 'ops', label: 'Ops' },
];

function normalise(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export default function BotTemplatesGallery({ connectedMcpServers, onUse }: BotTemplatesGalleryProps): JSX.Element {
  const [category, setCategory] = useState<'all' | BotTemplate['category']>('all');
  const [query, setQuery] = useState('');
  const connected = useMemo(() => new Set(connectedMcpServers.map(normalise)), [connectedMcpServers]);
  const filtered = useMemo(() => {
    const needle = normalise(query);
    return BOT_TEMPLATES.filter((template) => {
      if (category !== 'all' && template.category !== category) return false;
      if (!needle) return true;
      return [template.name, template.purpose, template.category, ...template.requiredMcp].some((value) => normalise(value).includes(needle));
    });
  }, [category, query]);
  const legacy = filtered.filter((template) => template.legacySeed);
  const newTemplates = filtered.filter((template) => !template.legacySeed);

  return <section className="space-y-6 text-foreground"><div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Bot Studio</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">Templates</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Start with a proven workflow, then make it yours in the Architect. Required MCP capabilities are shown before you commit to a template.</p></div><div className="relative w-full xl:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input aria-label="Search bot templates" className="field pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates…" /></div></div>
    <div className="flex flex-wrap items-center gap-2"><div className="flex flex-wrap gap-1.5 rounded-xl border border-border/70 bg-card p-1.5">{CATEGORIES.map((item) => <button key={item.value} type="button" className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${category === item.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} onClick={() => setCategory(item.value)}>{item.label}</button>)}</div><span className="text-[10px] text-muted-foreground">Green capabilities are connected. Connect the rest in the MCP catalog.</span></div>
    {filtered.length === 0 ? <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-12 text-center"><Sparkles className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-3 text-sm font-semibold">No templates match that search</p><p className="mt-1 text-xs text-muted-foreground">Try a different category or clear the search.</p></div> : <div className="space-y-7">{legacy.length > 0 ? <TemplateGroup title="Your previous sections" description="Your legacy sections, now available as paused Bot Studio starting points." templates={legacy} connected={connected} onUse={onUse} /> : null}{newTemplates.length > 0 ? <TemplateGroup title="Bot templates" description="Opinionated starting points for recurring work across your projects." templates={newTemplates} connected={connected} onUse={onUse} /> : null}</div>}
  </section>;
}

function TemplateGroup({ title, description, templates, connected, onUse }: { title: string; description: string; templates: BotTemplate[]; connected: Set<string>; onUse: (template: BotTemplate) => void }) {
  return <div><div className="mb-3"><h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</h2><p className="mt-1 max-w-2xl text-xs text-muted-foreground">{description}</p></div><div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">{templates.map((template) => <article key={template.key} className="group flex min-h-[236px] min-w-0 flex-col rounded-2xl border border-border/70 bg-card p-4 transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-sm"><div className="flex items-start justify-between gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-xl"><BotIcon icon={template.icon} size={22} /></span>{template.legacySeed ? <span className="shrink-0 rounded-full border border-border/70 bg-background px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">Legacy import</span> : null}</div><h3 className="mt-4 truncate text-sm font-semibold" title={template.name}>{template.name}</h3><p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{template.purpose}</p><div className="mt-4 flex flex-wrap gap-1.5">{template.requiredMcp.map((server) => { const isConnected = connected.has(normalise(server)); return <span key={server} className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[10px] ${isConnected ? 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300' : 'border-border/70 bg-background text-muted-foreground'}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} /><span className="truncate">{server}</span>{isConnected ? <Check className="h-3 w-3 shrink-0" /> : null}</span>; })}</div><button type="button" className="button group mt-auto w-full justify-center" onClick={() => onUse(template)}><WandSparkles className="h-3.5 w-3.5" />Use template</button></article>)}</div></div>;
}
