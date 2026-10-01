import { useCallback, useEffect, useMemo } from 'react';

import type { CreateMcSectionInput, McSection } from '../../../../mission-control/api/missionControlApi';
import { botRuntimeApi } from '../../../api/botRuntimeApi';
import { useBotRuntime } from '../../../hooks/useBotRuntime';
import type { BotSkill } from '../../../types/botRuntime';
import type { DetailFocus, DetailTab } from '../../detail/detailTabs';

import AccountsSection from './abilities/AccountsSection';
import AppsSection from './abilities/AppsSection';
import AutonomySection from './abilities/AutonomySection';
import SkillsSection from './abilities/SkillsSection';
import SpacesSection from './abilities/SpacesSection';
import { ABILITIES_SECTIONS, abilitiesChips, parseAbilitiesFocus } from './abilities/abilitiesModel';
import { ErrorLine } from './panel/Panel';
import { useNow } from './panel/useNow';
import { useRemote } from './panel/useRemote';

const SECTIONS = ['skills' as const, 'episodes' as const];

/**
 * Everything this bot can do and where to give it more: how much it may do alone, the apps it can use,
 * its skills, shared spaces, and its accounts and logins. One page, plain language, no jargon.
 */
export function AbilitiesTab({ botId, section, focus = null, onSave, onOpenTab }: {
  botId: string;
  section: McSection;
  focus?: DetailFocus;
  onSave?: (patch: Partial<CreateMcSectionInput>) => Promise<void>;
  onOpenTab?: (tab: DetailTab, focus?: DetailFocus) => void;
}) {
  const abilities = useRemote(() => botRuntimeApi.abilities.get(botId), botId);
  const runtime = useBotRuntime(botId, { sections: SECTIONS });
  const now = useNow();
  const { patchSection, refresh } = runtime;
  const patchSkills = useCallback((update: (current: BotSkill[]) => BotSkill[]) => patchSection('skills', update), [patchSection]);
  const refreshSkills = useCallback(() => { void refresh('skills'); }, [refresh]);
  const reloadAbilities = abilities.reload;
  const reload = useCallback(() => { void reloadAbilities(); }, [reloadAbilities]);
  const target = useMemo(() => parseAbilitiesFocus(focus), [focus]);
  const data = abilities.data;

  useEffect(() => {
    if (!target.section) return;
    document.getElementById(`abilities-${target.section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target.section, target.skill]);

  const serverSuggestions = useMemo(() => [...new Set([...(data?.apps.map((app) => app.server) ?? []), ...(section.produce_tools ?? []), ...(section.resolve_tools ?? [])])], [data, section.produce_tools, section.resolve_tools]);
  const chips = data ? abilitiesChips({
    autonomy: data.autonomy,
    apps: data.apps.length,
    skills: runtime.skills.length || data.skills_count,
    spaces: data.spaces_count,
    logins: data.credentials.length,
    browserProfile: data.browser.profile_exists,
  }) : [];

  return (
    <div className="bot-studio-controls max-w-4xl space-y-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold">Abilities</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">What {section.title} can do, and where to give it more. A bot starts with almost nothing: it can only use the apps, skills, notes and logins you give it here.</p>
        {chips.length ? <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Summary">{chips.map((chip) => <li key={chip} className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{chip}</li>)}</ul> : null}
        <nav aria-label="Abilities sections" className="mt-3 flex flex-wrap gap-1.5">
          {ABILITIES_SECTIONS.map((entry) => <button key={entry.id} type="button" className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => document.getElementById(`abilities-${entry.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{entry.label}</button>)}
        </nav>
      </div>
      <ErrorLine message={abilities.error && !data ? `Could not load this bot's abilities (${abilities.error}). The sections below still work.` : null} />

      <AutonomySection botId={botId} abilities={data} permissionMode={section.permission_mode} onChanged={reload} onOpenPipeline={() => onOpenTab?.('pipeline')} />
      <AppsSection section={section} abilities={data} onSave={onSave} onChanged={reload} onOpenPipeline={() => onOpenTab?.('pipeline', 'propose')} />
      <SkillsSection
        botId={botId}
        skills={runtime.skills}
        episodes={runtime.episodes}
        loading={runtime.isLoading('skills')}
        loadError={runtime.error('skills')}
        initialSkill={target.skill}
        patch={patchSkills}
        refresh={refreshSkills}
      />
      <SpacesSection botId={botId} onChanged={reload} />
      <AccountsSection botId={botId} botTitle={section.title} abilities={data} serverSuggestions={serverSuggestions} now={now} onChanged={reload} />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        Autonomy decides how far the bot goes before it asks, apps decide which services it can touch at all, and rules fine-tune single actions.
        <button type="button" className="underline hover:text-foreground" onClick={() => onOpenTab?.('rules')}>Open Rules</button>
        <button type="button" className="underline hover:text-foreground" onClick={() => onOpenTab?.('learning')}>Open Learning</button>
      </p>
    </div>
  );
}
