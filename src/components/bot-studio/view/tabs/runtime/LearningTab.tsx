import { useCallback, useMemo, useState } from 'react';

import type { McSection } from '../../../../mission-control/api/missionControlApi';
import type { DetailFocus, DetailTab } from '../../detail/detailTabs';
import { useBotRuntime } from '../../../hooks/useBotRuntime';
import type { BotProposal } from '../../../types/botRuntime';
import SegmentedControl from '../../../ui/SegmentedControl';

import { useNow } from './panel/useNow';
import PrivacyPanel from './learning/PrivacyPanel';
import ProfilePanel from './learning/ProfilePanel';
import ProposalsInbox from './learning/ProposalsInbox';
import TeachCard from './learning/TeachCard';
import { proposalCounts } from './learning/learningHelpers';

const SECTIONS = ['proposals' as const, 'skills' as const, 'episodes' as const, 'gateDecisions' as const];

type View = 'proposals' | 'skills' | 'teach' | 'preferences' | 'privacy';

/** How this bot gets better: reflector proposals, skills, teach mode, shared preferences and privacy controls. */
export function LearningTab({ botId, section, onOpenTab }: { botId: string; section: McSection; onOpenTab?: (tab: DetailTab, focus?: DetailFocus) => void }) {
  const runtime = useBotRuntime(botId, { sections: SECTIONS });
  const { patchSection, refresh } = runtime;
  const now = useNow();
  const [view, setView] = useState<View>('proposals');
  const pending = useMemo(() => proposalCounts(runtime.proposals).proposed, [runtime.proposals]);

  const patchProposals = useCallback((update: (current: BotProposal[]) => BotProposal[]) => patchSection('proposals', update), [patchSection]);
  /** Skills are created and edited on the Abilities tab (one editor, not two). */
  const openSkill = useCallback((name: string) => { void refresh('skills'); onOpenTab?.('abilities', `skill:${name}`); }, [refresh, onOpenTab]);

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
        <div className="space-y-2 rounded-xl border border-border/70 bg-card p-4">
          <p className="text-xs font-semibold">Skills now live on the Abilities tab</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">This bot has {runtime.skills.length} skill{runtime.skills.length === 1 ? '' : 's'}. Create, edit, switch on and link skills in one place, next to the apps, spaces and logins the bot can use.</p>
          <button type="button" className="button button-primary" onClick={() => onOpenTab?.('abilities', 'skills')}>Open Abilities → Skills</button>
        </div>
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
