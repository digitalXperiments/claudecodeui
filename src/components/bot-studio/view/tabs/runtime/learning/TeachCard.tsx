import { useEffect, useState } from 'react';
import { GraduationCap, Loader2, Square } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotSkill, BotTeachResult, BotTeachSession } from '../../../../types/botRuntime';
import { Chip, ErrorLine, Field, Panel, WarnLine } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import { parseSafeFields, parseSafeSteps } from './learningHelpers';

const CAPTURE_NOTES = [
  'Page navigations (web and https only; the query string and fragment are dropped).',
  'Clicks, with the visible text and a selector.',
  'Enter key presses.',
  'Typed fields and choices: a selector and a label only. The values you type are replaced by inputs the bot fills in later; password-like fields are never captured.',
];

/** Teach mode: show the bot a browser task once and it drafts a skill (saved disabled for your review). */
export default function TeachCard({ botId, onSkillSaved, onOpenSkill }: {
  botId: string;
  onSkillSaved: (skill: Pick<BotSkill, 'name'>) => void;
  onOpenSkill: (name: string) => void;
}) {
  const action = useAsyncAction();
  const [session, setSession] = useState<BotTeachSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [result, setResult] = useState<BotTeachResult | null>(null);
  const [url, setUrl] = useState('');
  const [useProfile, setUseProfile] = useState(true);
  const [name, setName] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [safeFields, setSafeFields] = useState('');
  const [safeSteps, setSafeSteps] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // A session started earlier (or in another tab) is still recording on the server.
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    botRuntimeApi.exec.teachStatus(botId)
      .then((active) => { if (!cancelled) setSession(active); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [botId]);

  const start = async () => {
    setFormError(null);
    setResult(null);
    const trimmed = url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) return setFormError('The start page must be an http or https URL.');
    await action.run('start', async () => {
      const started = await botRuntimeApi.exec.startTeach(botId, { ...(trimmed ? { url: trimmed } : {}), useBotProfile: useProfile });
      setSession(started);
    });
  };

  const stop = async () => {
    const steps = parseSafeSteps(safeSteps);
    if (!Array.isArray(steps)) return setFormError(steps.error);
    setFormError(null);
    await action.run('stop', async () => {
      const fields = parseSafeFields(safeFields);
      const stopped = await botRuntimeApi.exec.stopTeach(botId, {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(fields.length ? { safeFields: fields } : {}),
        ...(steps.length ? { safeSteps: steps } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });
      setSession(null);
      setResult(stopped);
      if (stopped.skill) onSkillSaved({ name: stopped.skill.name });
    });
  };

  return (
    <Panel
      title="Teach mode"
      description="Do a browser task once while CloudCLI watches. It writes the steps into a skill the bot can repeat. The skill is saved disabled so you can review it first."
      actions={session ? <Chip className="bg-destructive/10 text-destructive"><span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" />Recording</Chip> : null}
    >
      <div className="space-y-3">
        {checking ? <p className="text-xs text-muted-foreground">Checking for a running session…</p> : null}

        {!session && !checking ? (
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void start(); }} aria-label="Start teach mode">
            <Field label="Start page (optional)"><input aria-label="Start page" className="field h-9" placeholder="https://app.example.com" value={url} onChange={(event) => setUrl(event.target.value)} /></Field>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={useProfile} onChange={(event) => setUseProfile(event.target.checked)} />
              <span>Use this bot's own browser profile<span className="block text-[10px] text-muted-foreground">A login you make while teaching is kept for the bot. Off uses a temporary profile that is thrown away.</span></span>
            </label>
            <ErrorLine message={formError ?? action.error} />
            <div className="flex justify-end">
              <button type="submit" className="button button-primary" disabled={action.isBusy('start')}>{action.isBusy('start') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />}Start teaching</button>
            </div>
          </form>
        ) : null}

        {session ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-border/60 bg-background p-3 text-xs">
              <p className="font-medium">Recording{session.startUrl ? ` from ${session.startUrl}` : ''}</p>
              <ol className="mt-1.5 list-inside list-decimal space-y-1 text-[11px] text-muted-foreground">
                <li>Open the Browser panel; the session is waiting there under your control.</li>
                <li>Do the task once, the way you would want the bot to.</li>
                <li>Come back here and press Stop.</li>
              </ol>
              <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">What is recorded</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] text-muted-foreground">{CAPTURE_NOTES.map((note) => <li key={note}>{note}</li>)}</ul>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Skill name (optional)"><input aria-label="Taught skill name" className="field h-9 font-mono text-xs" placeholder="named from the first page if empty" value={name} onChange={(event) => setName(event.target.value)} /></Field>
              <label className="flex items-end gap-2 pb-2 text-[11px] text-muted-foreground"><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />Preview only (do not save a skill)</label>
            </div>
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-foreground">Keep some typed values as they are (advanced)</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Safe field selectors" hint="Comma separated, e.g. #search. Their typed value is kept in the skill instead of becoming an input. Only mark fields that hold nothing private.">
                  <input aria-label="Safe field selectors" className="field h-9 font-mono text-xs" value={safeFields} onChange={(event) => setSafeFields(event.target.value)} />
                </Field>
                <Field label="Safe step numbers" hint="Comma separated, e.g. 2, 4 (1-based, as listed after you stop).">
                  <input aria-label="Safe step numbers" className="field h-9" value={safeSteps} onChange={(event) => setSafeSteps(event.target.value)} />
                </Field>
              </div>
            </details>
            <ErrorLine message={formError ?? action.error} />
            <div className="flex justify-end">
              <button type="button" className="button button-primary" onClick={() => void stop()} disabled={action.isBusy('stop')}>{action.isBusy('stop') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" aria-hidden="true" />}Stop and build skill</button>
            </div>
          </div>
        ) : null}

        {result ? <TeachResult result={result} onOpenSkill={onOpenSkill} /> : null}
      </div>
    </Panel>
  );
}

function TeachResult({ result, onOpenSkill }: { result: BotTeachResult; onOpenSkill: (name: string) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs" aria-live="polite">
      {result.skill ? (
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Saved skill <code className="font-mono">{result.skill.name}</code></span>
          <Chip>Disabled</Chip>
          <button type="button" className="button min-h-7 px-2" onClick={() => onOpenSkill(result.skill!.name)}>Review and enable in Skills</button>
        </p>
      ) : <p className="font-medium">Preview only: nothing was saved, and the recording is gone. Run teach mode again to keep it.</p>}
      <p className="text-[11px] text-muted-foreground">Recorded {result.captured.actions} action{result.captured.actions === 1 ? '' : 's'}; {result.captured.skipped} skipped.</p>
      <ol className="space-y-1">
        {result.steps.map((step) => (
          <li key={step.index} className="flex items-start gap-2 text-[11px]">
            <span className="w-5 shrink-0 text-right font-semibold text-muted-foreground">{step.index}.</span>
            <span className="min-w-0 flex-1 break-words">{step.text}</span>
            {step.safeLiteral ? <Chip className="bg-amber-500/10 text-amber-700 dark:text-amber-300" title="You marked this value safe, so it is stored literally in the skill.">literal value kept</Chip> : null}
          </li>
        ))}
      </ol>
      {result.inputs.length > 0 ? (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Inputs the bot will fill in</p>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {result.inputs.map((input) => (
              <li key={`${input.name}-${input.step}`} className="flex flex-wrap items-center gap-1.5">
                <code className="font-mono">{input.name}</code><span className="text-muted-foreground">{input.label} · step {input.step}</span>
                {input.secret ? <Chip className="bg-violet-500/10 text-violet-700 dark:text-violet-300" title="Password-like: the bot asks you for it each time.">asks you each time</Chip> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.steps.length > 0 && result.inputs.length === 0 ? <WarnLine>No typed values were recorded, so this skill has no inputs.</WarnLine> : null}
    </div>
  );
}
