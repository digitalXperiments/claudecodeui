import { GraduationCap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { BotEpisode, BotSkill } from '../../../../types/botRuntime';
import SkillsPanel from '../learning/SkillsPanel';
import TeachCard from '../learning/TeachCard';

import AbilityCard from './AbilityCard';

/** Section 3: the bot's skills (the one place to create, edit, switch on and link them) plus Teach mode. */
export default function SkillsSection({ botId, skills, episodes, loading, loadError, initialSkill, patch, refresh }: {
  botId: string;
  skills: BotSkill[];
  episodes: BotEpisode[];
  loading: boolean;
  loadError: string | null;
  initialSkill: string | null;
  patch: (update: (current: BotSkill[]) => BotSkill[]) => void;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(initialSkill);
  const [teaching, setTeaching] = useState(false);
  useEffect(() => { if (initialSkill) setSelected(initialSkill); }, [initialSkill]);
  const openSkill = useCallback((name: string) => { refresh(); setSelected(name); setTeaching(false); }, [refresh]);
  return (
    <AbilityCard
      id="skills"
      number={3}
      title="Skills"
      description="A skill is a short how-to the bot follows, like a recipe for a task you repeat. Turn a skill on to let the bot use it; new skills start off until you have read them."
      actions={<button type="button" className="button" onClick={() => setTeaching((open) => !open)} aria-expanded={teaching}><GraduationCap className="h-3.5 w-3.5" />{teaching ? 'Close teach mode' : 'Teach by showing'}</button>}
    >
      {teaching ? <TeachCard botId={botId} onSkillSaved={refresh} onOpenSkill={openSkill} /> : null}
      <SkillsPanel botId={botId} skills={skills} loading={loading} loadError={loadError} episodes={episodes} selected={selected} onSelect={setSelected} patch={patch} />
    </AbilityCard>
  );
}
