import { useState } from 'react';

import type { BotRun } from '../../api/botStudioApi';
import type { Bot } from '../../types';
import SegmentedControl from '../../ui/SegmentedControl';

import TicksTab from './TicksTab';
import VersionsTab from './VersionsTab';

type HistoryView = 'ticks' | 'versions';

export default function HistoryTab({ bot, runs, initialView = 'ticks', selectedRunId, onSelectRun, onRun, onCancelRun }: { bot: Bot; runs: BotRun[]; initialView?: HistoryView; selectedRunId?: string | null; onSelectRun?: (run: BotRun) => void; onRun?: () => void; onCancelRun?: (run: BotRun) => void }) {
  const [view, setView] = useState<HistoryView>(initialView);
  return <div>
    <div className="px-4 pt-4 sm:px-6"><SegmentedControl value={view} onChange={setView} label="History view" options={[{ value: 'ticks', label: 'Ticks', count: runs.length }, { value: 'versions', label: 'Versions' }]} /></div>
    {view === 'ticks' ? <TicksTab bot={bot} runs={runs} onSelectRun={onSelectRun} selectedRunId={selectedRunId} onRun={onRun} onCancelRun={onCancelRun} /> : <VersionsTab key={bot.section_id} sectionId={bot.section_id} onSelectRun={onSelectRun} />}
  </div>;
}
