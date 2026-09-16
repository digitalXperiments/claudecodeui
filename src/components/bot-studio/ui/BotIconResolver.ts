import {
  Bell,
  BookOpen,
  Bot,
  Brain,
  Calendar,
  FileSearch,
  FileText,
  Folder,
  Globe,
  Inbox,
  Link,
  ListChecks,
  Mail,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  Star,
  Ticket,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Explicit map only: a namespace import of lucide-react would defeat tree-shaking
 * and pull every icon into the bundle. Keys are lowercase; SF Symbol names and
 * kebab/camel lucide names are normalised before lookup.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  ticket: Ticket,
  book: BookOpen,
  bookopen: BookOpen,
  'doc.text': FileText,
  filetext: FileText,
  'doc.text.magnifyingglass': FileSearch,
  filesearch: FileSearch,
  tray: Inbox,
  inbox: Inbox,
  envelope: Mail,
  mail: Mail,
  'bubble.left': MessageSquare,
  message: MessageSquare,
  messagesquare: MessageSquare,
  calendar: Calendar,
  checklist: ListChecks,
  listchecks: ListChecks,
  gear: Settings,
  settings: Settings,
  bolt: Zap,
  zap: Zap,
  star: Star,
  folder: Folder,
  link: Link,
  globe: Globe,
  bell: Bell,
  brain: Brain,
  sparkles: Sparkles,
  magnifyingglass: Search,
  search: Search,
  bot: Bot,
};

function isSingleGrapheme(value: string): boolean {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<unknown> } }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)).length === 1;
  return Array.from(value).length === 1;
}

export type BotIconResolution = { kind: 'text'; value: string } | { kind: 'icon'; value: LucideIcon };

/** Resolve legacy SF Symbol names, emoji, and known lucide names; unknown values fall back to Bot. */
export function resolveBotIcon(icon: string | null | undefined): BotIconResolution {
  const value = icon?.trim() ?? '';
  if (value && /[^\x00-\x7F]/u.test(value) && isSingleGrapheme(value)) return { kind: 'text', value };
  const direct = ICON_MAP[value.toLowerCase()];
  if (direct) return { kind: 'icon', value: direct };
  const normalised = value.toLowerCase().replace(/[-_\s]+/g, '');
  const mapped = normalised ? ICON_MAP[normalised] : undefined;
  return { kind: 'icon', value: mapped ?? Bot };
}
