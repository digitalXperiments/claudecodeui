import { AlertTriangle, ShieldCheck, ShieldHalf, ShieldOff } from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '../../../../../../lib/utils';
import type { BotAutonomy } from '../../../../types/botRuntime';

import {
  AUTONOMY_CHOICES, BYPASS_CONFIRMATION, BYPASS_WARNING, isBypassConfirmation, needsTypedConfirmation,
  type AutonomyChoice, type AutonomyTone,
} from './abilitiesModel';

const ICONS: Record<AutonomyTone, typeof ShieldCheck> = { safe: ShieldCheck, caution: ShieldHalf, danger: ShieldOff };

const ACTIVE: Record<AutonomyTone, string> = {
  safe: 'border-emerald-500/60 bg-emerald-500/[0.07] ring-2 ring-emerald-500/20',
  caution: 'border-amber-500/60 bg-amber-500/[0.07] ring-2 ring-amber-500/20',
  danger: 'border-red-500/70 bg-red-500/[0.08] ring-2 ring-red-500/25',
};

const ICON_TONE: Record<AutonomyTone, string> = {
  safe: 'text-emerald-600 dark:text-emerald-400',
  caution: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};

function ChoiceCard({ choice, selected, disabled, onPick }: { choice: AutonomyChoice; selected: boolean; disabled: boolean; onPick: () => void }) {
  const Icon = ICONS[choice.tone];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        'flex h-full flex-col gap-2 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        selected ? ACTIVE[choice.tone] : 'border-border/70 bg-card hover:bg-accent/30',
      )}
    >
      <span className="flex items-center gap-2">
        <Icon className={cn('h-5 w-5 shrink-0', ICON_TONE[choice.tone])} aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground">{choice.label}</span>
        {selected ? <span className="ml-auto rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-medium text-foreground">Selected</span> : null}
      </span>
      <span className="text-[11px] font-medium text-foreground/80">{choice.tagline}</span>
      <span className="text-[11px] leading-relaxed text-muted-foreground">{choice.meaning}</span>
    </button>
  );
}

/**
 * The three autonomy choices as big cards. Ask and Auto apply as soon as they are picked;
 * Bypass opens a red warning and needs the word typed before it is applied.
 * Used by the Abilities tab and by the wizard's Guardrails step.
 */
export default function AutonomyPicker({ value, onChange, disabled = false, label = 'How much can this bot do on its own?' }: {
  value: BotAutonomy;
  onChange: (next: BotAutonomy) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const confirmId = useId();
  const pick = (next: BotAutonomy) => {
    if (next === value) { setConfirming(false); return; }
    if (needsTypedConfirmation(next)) { setConfirming(true); setTyped(''); return; }
    setConfirming(false);
    onChange(next);
  };
  const confirm = () => {
    if (!isBypassConfirmation(typed)) return;
    setConfirming(false);
    setTyped('');
    onChange('bypass');
  };
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={label} className="grid gap-3 md:grid-cols-3">
        {AUTONOMY_CHOICES.map((choice) => <ChoiceCard key={choice.value} choice={choice} selected={choice.value === value} disabled={disabled} onPick={() => pick(choice.value)} />)}
      </div>
      {value === 'bypass' && !confirming ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />This bot is Bypass. Nothing checks what it does.
        </p>
      ) : null}
      {confirming ? (
        <div role="alertdialog" aria-labelledby={`${confirmId}-title`} className="space-y-2 rounded-xl border border-red-500/50 bg-red-500/10 p-4">
          <p id={`${confirmId}-title`} className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300"><AlertTriangle className="h-4 w-4" aria-hidden="true" />Switch to Bypass?</p>
          <p className="text-xs leading-relaxed text-red-800 dark:text-red-200">{BYPASS_WARNING}</p>
          <label className="block text-[11px] text-red-800 dark:text-red-200" htmlFor={`${confirmId}-input`}>Type <strong>{BYPASS_CONFIRMATION}</strong> to confirm</label>
          <input
            id={`${confirmId}-input`}
            className="field h-9 max-w-xs"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${BYPASS_CONFIRMATION} to confirm`}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } }}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="button" onClick={() => { setConfirming(false); setTyped(''); }}>Keep {value === 'auto' ? 'Auto' : 'Ask'}</button>
            <button type="button" className="button border-red-500/60 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50" disabled={!isBypassConfirmation(typed)} onClick={confirm}>Make it Bypass</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
