import {
  BellRing, CalendarClock, CheckCircle2, Clock, Columns3, Eye, Hand, MessageSquare, Timer, Users, Webhook, Flag,
  type LucideIcon,
} from 'lucide-react';

export const KIND_ICONS: Record<string, LucideIcon> = {
  cron: Clock,
  nl_schedule: CalendarClock,
  interval: Timer,
  webhook: Webhook,
  watch: Eye,
  run_completed: CheckCircle2,
  kanban_event: Columns3,
  interrupt_created: BellRing,
  peer_message: Users,
  ask_bot: Users,
  commitment_due: Flag,
  operator_message: MessageSquare,
  manual: Hand,
};

export const kindIcon = (kind: string): LucideIcon => KIND_ICONS[kind] ?? Clock;
