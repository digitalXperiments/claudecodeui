import type { Project } from '../../../types/app';
import type { CreateMcSectionInput, McAction, McItem, WorkProjectMatch } from '../../mission-control/api/missionControlApi';
import type { BotRun } from '../api/botStudioApi';
import type { Bot, BotAutonomy } from '../types';

export type RunDetail = BotRun & { bot_id?: string; bot_title?: string };

/** Props supplied to the unified cross-bot inbox. */
export interface InboxViewProps {
  /** Items currently loaded from Mission Control. */
  items: McItem[];
  /** Bot view models used for labels, filtering, and autonomy. */
  bots: Bot[];
  /** Client-side search query from the shell header. */
  search: string;
  /** Currently focused inbox item id. */
  selectedItemId: string | null;
  /** Select an item for the context pane. */
  onSelectItem: (item: McItem) => void;
  /** Execute an action on an item. */
  onAction: (item: McItem, action: McAction, body?: Record<string, unknown>) => void;
  /** Preview an action without changing item state. */
  onPreview: (item: McItem, action?: McAction) => void;
  /** Retry a failed item. */
  onRetry: (item: McItem) => void;
  /** Hand an item off to a chat session. */
  onWork: (item: McItem) => void;
  /** Render missing assets for an article item. */
  onGenerateAssets: (item: McItem, force: boolean) => Promise<{ generated: number; skipped: number; failed: number; messages: string[] }>;
  /** Explain skipped batch selections to the user. */
  onNotice?: (message: string) => void;
}

/** Props for one compact inbox card. */
export interface InboxItemCardProps {
  /** Item represented by the card. */
  item: McItem;
  /** Owning bot, when its section is still present. */
  bot?: Bot;
  /** Whether the card is the context-pane selection. */
  selected: boolean;
  /** Whether the card is selected for a batch operation. */
  checked: boolean;
  /** Select the card. */
  onSelect: () => void;
  /** Change batch selection state. */
  onCheck: (checked: boolean) => void;
  /** Execute an item action. */
  onAction: (item: McItem, action: McAction, body?: Record<string, unknown>) => void;
  /** Open an action preview. */
  onPreview: (item: McItem, action?: McAction) => void;
  /** Retry this item. */
  onRetry: (item: McItem) => void;
  /** Start a chat work session for this item. */
  onWork: (item: McItem) => void;
  /** Render article assets. */
  onGenerateAssets: (force: boolean) => Promise<{ generated: number; skipped: number; failed: number; messages: string[] }>;
}

/** Props for the context pane shown beside the centre view. */
export interface ContextPaneProps {
  /** Selected inbox item, or null for the empty state. */
  item: McItem | null;
  /** Selected bot used for context metadata. */
  bot?: Bot;
  /** Latest action preview payload. */
  preview: Record<string, unknown> | null;
  /** Steering note persisted into the next action body. */
  operatorContext: string;
  /** Update the steering note draft. */
  onOperatorContextChange: (value: string) => void;
  /** Apply edited item body JSON. */
  onBodyChange: (body: Record<string, unknown>) => void;
  /** Generate article assets through the real Mission Control endpoint. */
  onGenerateAssets?: (item: McItem, force: boolean) => Promise<{ generated: number; skipped: number; failed: number; messages: string[] }>;
  /** Close the current context selection. */
  onClose?: () => void;
  /** Candidate projects for the explicit work-chat handoff. */
  workCandidates?: WorkProjectMatch[] | null;
  /** Whether project matching is in flight. */
  workLoading?: boolean;
  /** Project matching or handoff error. */
  workError?: string | null;
  /** Find projects or open a chat in the selected project. */
  onWork?: (item: McItem, projectId?: string) => void;
  /** Selected tick detail; optional so inbox consumers remain compatible. */
  selectedRun?: RunDetail | null;
  /** Select a related tick for context details. */
  onSelectRun?: (run: BotRun) => void;
}

/** Common props available to every bot detail tab. */
export interface BotDetailTabProps {
  /** Bot being edited or inspected. */
  bot: Bot;
  /** Persist a section patch. */
  onUpdate: (patch: Partial<CreateMcSectionInput>) => Promise<void>;
  /** Current bot inbox items. */
  items: McItem[];
  /** Cached tick runs for this bot. */
  runs: BotRun[];
  /** Select an inbox item or run in the context pane. */
  onSelectItem?: (item: McItem) => void;
  /** Select a tick run in the context pane. */
  onSelectRun?: (run: BotRun) => void;
}

/** Props for a complete bot detail centre view. */
export interface BotDetailViewProps {
  /** Bot represented by the detail page. */
  bot: Bot;
  /** Display name for the configured project, when the project is still registered. */
  projectName?: string | null;
  /** Display name for the configured Work this destination. */
  workProjectName?: string | null;
  /** Inbox items produced by this bot. */
  items: McItem[];
  /** Tick runs cached for this bot. */
  runs: BotRun[];
  /** Save a bot section patch. */
  onUpdate: (patch: Partial<CreateMcSectionInput>) => Promise<void>;
  /** Run one tick immediately. */
  onRun: () => Promise<{ created: number; skipped?: number }>;
  /** Cancel an in-progress tick, killing its underlying process. */
  onCancelRun?: (run: BotRun) => void;
  /** Delete the bot after confirmation. */
  onDelete: () => Promise<void>;
  /** Create a disabled copy of the bot. */
  onDuplicate: () => Promise<void>;
  /** Open the Architect in edit mode. */
  onEdit: () => void;
  /** Select an item for the context pane. */
  onSelectItem: (item: McItem) => void;
  /** Controlled detail tab from the URL, when supplied. */
  selectedTab?: string;
  /** Persist a detail tab change in the URL. */
  onTabChange?: (tab: string) => void;
  /** Select a run for the context pane. */
  onSelectRun?: (run: BotRun) => void;
  /** Set autonomy directly from a shell-level control. */
  onAutonomyChange?: (autonomy: BotAutonomy) => void;
}

/** Props for the cross-bot activity feed. */
export interface ActivityViewProps {
  /** Bots used to decorate each run. */
  bots: Bot[];
  /** Runs keyed by section id. */
  runsBySection: Record<string, BotRun[]>;
  /** Whether the runs cache is still loading. */
  isLoading?: boolean;
  /** Load the first page for every bot when the activity view opens. */
  onLoad?: () => void;
  /** Load the next page for every bot. */
  onLoadMore?: () => void;
  /** Whether another activity page is available. */
  hasMore?: boolean;
  /** Whether a page request is in flight. */
  isLoadingMore?: boolean;
  /** Select a run for context details. */
  onSelectRun?: (run: BotRun, bot: Bot) => void;
}

/** Props for the legacy-section migration screen. */
export interface ImportViewProps {
  /** Optional projects to use when an importer offers project mapping. */
  projects?: Project[];
  /** Called after a successful import. */
  onImported?: () => void;
}
