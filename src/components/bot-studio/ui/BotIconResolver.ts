import * as LucideIcons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  ticket: LucideIcons.Ticket,
  book: LucideIcons.BookOpen,
  'doc.text': LucideIcons.FileText,
  tray: LucideIcons.Inbox,
  envelope: LucideIcons.Mail,
  mail: LucideIcons.Mail,
  'bubble.left': LucideIcons.MessageSquare,
  message: LucideIcons.MessageSquare,
  calendar: LucideIcons.Calendar,
  checklist: LucideIcons.ListChecks,
  gear: LucideIcons.Settings,
  bolt: LucideIcons.Zap,
  star: LucideIcons.Star,
  folder: LucideIcons.Folder,
  link: LucideIcons.Link,
  globe: LucideIcons.Globe,
  bell: LucideIcons.Bell,
  brain: LucideIcons.Brain,
  sparkles: LucideIcons.Sparkles,
  magnifyingglass: LucideIcons.Search,
  search: LucideIcons.Search,
  'doc.text.magnifyingglass': LucideIcons.FileSearch,
};

function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

function isSingleGrapheme(value: string): boolean {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<unknown> } }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)).length === 1;
  return Array.from(value).length === 1;
}

export type BotIconResolution = { kind: 'text'; value: string } | { kind: 'icon'; value: LucideIcon };

/** Resolve legacy SF Symbol names, emoji, and lucide-compatible names. */
export function resolveBotIcon(icon: string | null | undefined): BotIconResolution {
  const value = icon?.trim() ?? '';
  if (value && /[^\x00-\x7F]/u.test(value) && isSingleGrapheme(value)) return { kind: 'text', value };
  const mapped = ICON_MAP[value.toLowerCase()];
  if (mapped) return { kind: 'icon', value: mapped };
  const desiredName = pascalCase(value).toLowerCase();
  const candidate = value ? Object.entries(LucideIcons).find(([name, exportValue]) => name.toLowerCase() === desiredName && typeof exportValue === 'function')?.[1] : undefined;
  if (candidate) return { kind: 'icon', value: candidate as LucideIcon };
  return { kind: 'icon', value: LucideIcons.Bot };
}
