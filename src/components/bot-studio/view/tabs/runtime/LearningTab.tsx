import { useCallback, useMemo, useState } from 'react';

import type { McSection } from '../../../../mission-control/api/missionControlApi';
import { useBotRuntime } from '../../../hooks/useBotRuntime';
import type { BotProposal, BotSkill } from '../../../types/botRuntime';
import SegmentedControl from '../../../ui/SegmentedControl';

import { useNow } from './panel/useNow';
import PrivacyPanel from './learning/PrivacyPanel';
import ProfilePanel from './learning/ProfilePanel';
import ProposalsInbox from './learning/ProposalsInbox';
import SkillsPanel from './learning/SkillsPanel';
import TeachCard from './learning/TeachCard';
import { proposalCounts } from './learning/learningHelpers';

const SECTIONS = ['proposals' as const, 'skills' as const, 'episodes' as const, 'gateDecisions' as const];

type View = 'proposals' | 'skills' | 'teach' | 'preferences' | 'privacy';

/** How this bot gets better: reflector proposals, skills, teach mode, shared preferences and privacy controls. */
export function LearningTab({ botId, section }: { botId: string; section: McSection }) {
  const runtime = useBotRuntime(botId, { sections: SECTIONS });
  const { patchSection, refresh } = runtime;
  const now = useNow();
  const [view, setView] = useState<View>('proposals');
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const pending = useMemo(() => proposalCounts(runtime.proposals).proposed, [runtime.proposals]);

  const patchProposals = useCallback((update: (current: BotProposal[]) => BotProposal[]) => patchSection('proposals', update), [patchSection]);
  const patchSkills = useCallback((update: (current: BotSkill[]) => BotSkill[]) => patchSection('skills', update), [patchSection]);
  const openSkill = useCallback((name: string) => { void refresh('skills'); setSelectedSkill(name); setView('skills'); }, [refresh]);

  return (
    <div className="bot-studio-controls max-w-4xl space-y-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold">Learning</h2>
        <p className="mt-1 text-xs text-muted-foreground">Nothing the bot learns takes effect until you approve it. Skills and preferences are yours to edit directly.</p>
      </div>
      <SegmentedControl<View>
        label="Learning sections"
        value={view}
        onChange={setView}
        options={[
          { value: 'proposals', label: 'Proposals', count: pending },
          { value: 'skills', label: 'Skills', count: runtime.skills.length },
          { value: 'teach', label: 'Teach mode' },
          { value: 'preferences', label: 'Preferences' },
          { value: 'privacy', label: 'Privacy' },
        ]}
      />

      {view === 'proposals' ? (
        <ProposalsInbox
          botId={botId}
          proposals={runtime.proposals}
          loading={runtime.isLoading('proposals')}
          loadError={runtime.error('proposals')}
          episodes={runtime.episodes}
          decisions={runtime.gateDecisions}
          now={now}
          patch={patchProposals}
          onChanged={() => { void refresh('skills'); }}
        />
      ) : null}
      {view === 'skills' ? (
        <SkillsPanel
          botId={botId}
          skills={runtime.skills}
          loading={runtime.isLoading('skills')}
          loadError={runtime.error('skills')}
          episodes={runtime.episodes}
          selected={selectedSkill}
          onSelect={setSelectedSkill}
          patch={patchSkills}
        />
      ) : null}
      {view === 'teach' ? <TeachCard botId={botId} onSkillSaved={() => { void refresh('skills'); }} onOpenSkill={openSkill} /> : null}
      {view === 'preferences' ? <ProfilePanel now={now} /> : null}
      {view === 'privacy' ? (
        <PrivacyPanel
          botId={botId}
          title={section.title}
          onPurged={() => { void runtime.refreshAll(); }}
        />
      ) : null}
    </div>
  );
}
