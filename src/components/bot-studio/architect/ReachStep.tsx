import { ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';

import SecretRefPicker from '../../secrets/view/SecretRefPicker';
import type { BotChannel } from '../types/botRuntime';
import { channelMeta, normalizeSecretRef, policySummary, validateQuietHours, type ConfigDraft } from '../view/runtime/channelsModel';

import { planChannels } from './channelPlan';
import { Callout, FieldLabel, SwitchRow } from './parts';
import {
  DEFAULT_AUTO_APPLY_CONFIDENCE, EMPTY_CHANNEL_CONFIG, type OwnChannelKind, type RuntimeDraft,
} from './runtimeDraft';

function SecretField({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint: string }) {
  const invalid = normalizeSecretRef(value) === null;
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <input className="field font-mono text-xs" aria-label={label} aria-invalid={invalid} value={value} placeholder="${secret:NAME}" spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
        <SecretRefPicker label="Pick" onPick={onChange} />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function OwnChannel({ kind, draft, onEnabled, onConfig }: {
  kind: OwnChannelKind;
  draft: { enabled: boolean; config: ConfigDraft } | undefined;
  onEnabled: (enabled: boolean) => void;
  onConfig: (patch: Partial<ConfigDraft>) => void;
}) {
  const meta = channelMeta(kind);
  const config = draft?.config ?? EMPTY_CHANNEL_CONFIG;
  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-xs font-semibold text-foreground">{meta.label} just for this bot</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{meta.description}</p></div>
        <button type="button" role="switch" aria-checked={Boolean(draft?.enabled)} aria-label={`Add a ${meta.label} channel for this bot`} className={`toggle ${draft?.enabled ? 'toggle-on' : ''}`} onClick={() => onEnabled(!draft?.enabled)}><span /></button>
      </div>
      {draft?.enabled && kind === 'slack' ? (
        <div className="space-y-3">
          <div className="inline-flex rounded-lg border border-border bg-background p-0.5" role="group" aria-label="Slack delivery method">
            {(['bot', 'webhook'] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={config.slackMode === mode} onClick={() => onConfig({ slackMode: mode })} className={`rounded-md px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${config.slackMode === mode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{mode === 'bot' ? 'Bot token + channel' : 'Incoming webhook'}</button>
            ))}
          </div>
          {config.slackMode === 'bot' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <SecretField label="Bot token secret" value={config.tokenRef} onChange={(tokenRef) => onConfig({ tokenRef })} hint="A reference to a vault secret. The token itself never leaves the vault." />
              <div><FieldLabel>Channel id</FieldLabel><input className="field" aria-label="Slack channel id" value={config.channelId} placeholder="C0123456789" onChange={(event) => onConfig({ channelId: event.target.value })} /><p className="mt-1 text-[10px] text-muted-foreground">The id, not the channel name.</p></div>
            </div>
          ) : <SecretField label="Webhook URL secret" value={config.webhookUrlRef} onChange={(webhookUrlRef) => onConfig({ webhookUrlRef })} hint="Store the incoming-webhook URL as a vault secret and reference it here." />}
        </div>
      ) : null}
      {draft?.enabled && kind === 'telegram' ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SecretField label="Bot token secret" value={config.tokenRef} onChange={(tokenRef) => onConfig({ tokenRef })} hint="A reference to a vault secret. The token itself never leaves the vault." />
            <div><FieldLabel>Chat id</FieldLabel><input className="field" inputMode="numeric" aria-label="Telegram chat id" value={config.chatId} placeholder="123456789" onChange={(event) => onConfig({ chatId: event.target.value })} /><p className="mt-1 text-[10px] text-muted-foreground">The numeric id of the chat to message.</p></div>
          </div>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={config.inbound} onChange={(event) => onConfig({ inbound: event.target.checked })} /><span><span className="font-medium">Accept replies</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Messages you send the bot in that chat reach your bots. Only the configured chat is accepted.</span></span></label>
          {config.inbound ? <p className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-300"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />Keep that chat private: anyone who can post in it can talk to your bots.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Channels, quiet hours and learning for a new bot. Nothing is created until the bot is. */
export default function ReachStep({ runtime, onChange, globals }: {
  runtime: RuntimeDraft;
  onChange: (patch: Partial<RuntimeDraft>) => void;
  globals: { data: BotChannel[] | null; loading: boolean; error: string | null; reload: () => void };
}) {
  const { channels, learning } = runtime;
  const setChannels = (patch: Partial<RuntimeDraft['channels']>) => onChange({ channels: { ...channels, ...patch } });
  const sharedChannels = (globals.data ?? []).filter((channel) => channel.bot_id === null && channel.kind !== 'inapp');
  const quiet = channels.quiet;
  const quietError = quiet.enabled ? validateQuietHours(quiet.start, quiet.end, quiet.tz) : null;
  const plan = planChannels(channels, globals.data ?? []);
  const quietReaches = plan.ops.some((op) => op.quiet);
  const pct = Math.round(learning.minConfidence * 100);

  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="architect-channels-heading">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="architect-channels-heading" className="text-sm font-semibold text-foreground">Where should it reach you?</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">In-app notifications are always on. Shared channels you set up once apply to every bot; untick one to keep this bot off it.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Refresh channels" onClick={globals.reload}><RefreshCw className={`h-4 w-4 ${globals.loading ? 'animate-spin' : ''}`} /></button>
        </div>
        {globals.error ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{globals.error}</p> : null}
        {!globals.loading && !globals.error && sharedChannels.length === 0 ? <Callout>No shared channels yet, so this bot will notify you in the app only. Add one just for this bot below, or set up shared channels for every bot on the <a className="inline-flex items-center gap-1 font-medium text-primary" href="/bots/channels">Channels page <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>.</Callout> : null}
        {sharedChannels.length > 0 ? (
          <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
            {sharedChannels.map((channel) => {
              const use = !channels.skipGlobal.includes(channel.channel_id);
              return (
                <li key={channel.channel_id} className="px-3 py-2.5">
                  <label className="flex items-start gap-3 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={use} onChange={(event) => setChannels({ skipGlobal: event.target.checked ? channels.skipGlobal.filter((id) => id !== channel.channel_id) : [...channels.skipGlobal, channel.channel_id] })} />
                    <span className="min-w-0"><span className="font-medium text-foreground">Use {channelMeta(channel.kind).label} for this bot</span><span className="block text-[10px] text-muted-foreground">{channel.enabled ? 'Shared channel' : 'Shared channel (currently switched off)'} · {policySummary(channel.policy)}</span></span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}

        <OwnChannel kind="slack" draft={channels.own.slack} onEnabled={(enabled) => setChannels({ own: { ...channels.own, slack: { enabled, config: channels.own.slack?.config ?? EMPTY_CHANNEL_CONFIG } } })} onConfig={(patch) => setChannels({ own: { ...channels.own, slack: { enabled: true, config: { ...(channels.own.slack?.config ?? EMPTY_CHANNEL_CONFIG), ...patch } } } })} />
        <OwnChannel kind="telegram" draft={channels.own.telegram} onEnabled={(enabled) => setChannels({ own: { ...channels.own, telegram: { enabled, config: channels.own.telegram?.config ?? EMPTY_CHANNEL_CONFIG } } })} onConfig={(patch) => setChannels({ own: { ...channels.own, telegram: { enabled: true, config: { ...(channels.own.telegram?.config ?? EMPTY_CHANNEL_CONFIG), ...patch } } } })} />
        {plan.errors.length > 0 ? <ul role="alert" className="space-y-1 text-xs text-red-600 dark:text-red-300">{plan.errors.map((message) => <li key={message}>{message}</li>)}</ul> : null}
      </section>

      <section className="space-y-3" aria-label="Quiet hours">
        <SwitchRow title="Quiet hours" description="Hold pings during a window; held items show up in your morning brief instead." checked={quiet.enabled} onChange={(enabled) => setChannels({ quiet: { ...quiet, enabled } })} />
        {quiet.enabled ? (
          <div className="grid gap-3 rounded-xl border border-border/60 p-3 sm:grid-cols-3">
            <div><FieldLabel>From</FieldLabel><input type="time" className="field" aria-label="Quiet hours start" value={quiet.start} onChange={(event) => setChannels({ quiet: { ...quiet, start: event.target.value } })} /></div>
            <div><FieldLabel>Until</FieldLabel><input type="time" className="field" aria-label="Quiet hours end" value={quiet.end} onChange={(event) => setChannels({ quiet: { ...quiet, end: event.target.value } })} /></div>
            <div><FieldLabel detail="optional">Time zone</FieldLabel><input className="field" aria-label="Quiet hours time zone" value={quiet.tz} placeholder="Asia/Dubai" onChange={(event) => setChannels({ quiet: { ...quiet, tz: event.target.value } })} /></div>
            {quietError ? <p role="alert" className="text-xs text-red-600 dark:text-red-300 sm:col-span-3">{quietError}</p> : null}
            <p className="text-[11px] text-muted-foreground sm:col-span-3">{quietReaches ? 'Applies to the Slack, Telegram and push channels this bot uses, saved as this bot\'s own copy of each.' : 'Quiet hours apply to Slack, Telegram and push channels. With in-app notifications only, there is nothing to hold yet.'}</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="architect-learning-heading">
        <div>
          <h3 id="architect-learning-heading" className="text-sm font-semibold text-foreground">Learning</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">After each wake-up the bot reflects and may suggest a memory, a rule or a skill. You see every suggestion in the bot's Learning tab. This is always on and nothing takes effect until you approve it, with the one optional exception below.</p>
        </div>
        <SwitchRow
          title="Auto-apply memories I would obviously approve"
          description="Only memories can apply on their own, and only above the confidence you choose. Rules, skills and goals always wait for you."
          checked={learning.autoApply}
          onChange={(autoApply) => onChange({ learning: { ...learning, autoApply, minConfidence: learning.minConfidence || DEFAULT_AUTO_APPLY_CONFIDENCE } })}
        />
        {learning.autoApply ? (
          <div className="rounded-xl border border-border/60 p-3">
            <FieldLabel detail={`${pct}%`}>Minimum confidence</FieldLabel>
            <input type="range" min={0.5} max={1} step={0.05} className="w-full accent-primary" aria-label="Minimum confidence to auto-apply a memory" aria-valuetext={`${pct} percent`} value={learning.minConfidence} onChange={(event) => onChange({ learning: { ...learning, minConfidence: Number(event.target.value) } })} />
            <p className="mt-1 text-[11px] text-muted-foreground">Higher means fewer, safer auto-applied memories. You can review and remove any memory later.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
