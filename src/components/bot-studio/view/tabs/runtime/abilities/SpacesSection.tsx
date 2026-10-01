import { useState } from 'react';

import SpacesPanel from '../../../runtime/SpacesPanel';

import AbilityCard from './AbilityCard';

/** Section 4: shared notes you and this bot can both read and write, managed right here (no Teams detour). */
export default function SpacesSection({ botId, onChanged }: { botId: string; onChanged: () => void }) {
  const [notice, setNotice] = useState<{ message: string; tone: 'default' | 'error' | 'success' } | null>(null);
  return (
    <AbilityCard
      id="spaces"
      number={4}
      title="Spaces"
      description="A space is a shared notes file (plain text) that you and this bot can both read and write. Use one to hand the bot background, a checklist, or a running log."
    >
      <SpacesPanel botId={botId} onNotice={(message, tone) => { setNotice({ message, tone }); onChanged(); }} />
      {notice ? <p role="status" className={notice.tone === 'error' ? 'text-[11px] text-destructive' : 'text-[11px] text-emerald-700 dark:text-emerald-300'}>{notice.message}</p> : null}
    </AbilityCard>
  );
}
