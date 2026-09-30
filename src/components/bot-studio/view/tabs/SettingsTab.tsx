import type { McItem } from '../../../mission-control/api/missionControlApi';
import type { Bot } from '../../types';

import DangerTab from './DangerTab';
import MemoryTab from './MemoryTab';
import TrustTab from './TrustTab';

/** Guardrails, memory, and the danger zone stacked on one page. */
export default function SettingsTab({ bot, items, onOpenPipeline, onDelete, onResetPolicy }: { bot: Bot; items: McItem[]; onOpenPipeline: () => void; onDelete: () => Promise<void>; onResetPolicy: () => Promise<void> }) {
  return <div className="divide-y divide-border/70">
    <TrustTab bot={bot} onOpenTools={onOpenPipeline} />
    <MemoryTab key={bot.section_id} sectionId={bot.section_id} items={items} />
    <DangerTab bot={bot} onDelete={onDelete} onResetPolicy={onResetPolicy} />
  </div>;
}
