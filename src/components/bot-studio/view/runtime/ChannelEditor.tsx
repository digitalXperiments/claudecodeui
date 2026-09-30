import { ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { botRuntimeApi } from '../../api/botRuntimeApi';
import SecretRefPicker from '../../../secrets/view/SecretRefPicker';
import type { BotChannel } from '../../types/botRuntime';

import {
  EMAIL_DEFERRED_MESSAGE,
  addableKinds,
  channelMeta,
  configToDraft,
  draftToConfig,
  draftToPolicy,
  normalizeSecretRef,
  policyToDraft,
  type ConfigDraft,
  type PolicyDraft,
} from './channelsModel';
import PolicyEditor from './PolicyEditor';
import { ErrorBanner, Field } from './RuntimePage';
import { errorText } from './useLoad';

function SecretField({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint?: string }) {
  const normalized = normalizeSecretRef(value);
  return <Field label={label} hint={hint ?? 'A reference to a vault secret. The value never leaves the vault; raw tokens are rejected.'}>
    <div className="flex items-center gap-2">
      <input className="field font-mono text-xs" value={value} placeholder="${secret:NAME}" onChange={(event) => onChange(event.target.value)} spellCheck={false} autoComplete="off" aria-invalid={normalized === null} />
      <SecretRefPicker label="Pick" onPick={(ref) => onChange(ref)} />
    </div>
  </Field>;
}

export type ChannelEditorProps = {
  /** Existing channel to edit; omit to create. */
  channel?: BotChannel;
  bots: Array<{ section_id: string; title: string }>;
  /** Channels already configured, used to hide kinds that already exist in the chosen scope. */
  existing: BotChannel[];
  /** Scope preselected for create (null = global). */
  defaultBotId?: string | null;
  onSaved: (channel: BotChannel) => void;
  onCancel: () => void;
};

export default function ChannelEditor({ channel, bots, existing, defaultBotId = null, onSaved, onCancel }: ChannelEditorProps) {
  const editing = Boolean(channel);
  const [botId, setBotId] = useState<string | null>(channel ? channel.bot_id : defaultBotId);
  const scopeChannels = useMemo(() => existing.filter((entry) => entry.bot_id === botId), [existing, botId]);
  const kinds = useMemo(() => addableKinds(scopeChannels), [scopeChannels]);
  const [kind, setKind] = useState<string>(channel?.kind ?? '');
  const activeKind = editing ? channel!.kind : (kinds.some((entry) => entry.kind === kind) ? kind : (kinds[0]?.kind ?? ''));
  const [config, setConfig] = useState<ConfigDraft>(() => configToDraft(channel?.kind ?? '', channel?.config));
  const [policy, setPolicy] = useState<PolicyDraft>(() => policyToDraft(channel?.policy));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const meta = channelMeta(activeKind);
  const setCfg = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) => setConfig((current) => ({ ...current, [key]: value }));

  const save = async () => {
    const built = draftToConfig(activeKind, config, channel?.config);
    const builtPolicy = draftToPolicy(policy, { global: botId === null });
    const problems = [...built.errors, ...builtPolicy.errors];
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      const saved = channel
        ? await botRuntimeApi.channels.update(channel.channel_id, { config: built.config, policy: builtPolicy.policy })
        : await botRuntimeApi.channels.create({ botId, kind: activeKind, config: built.config, policy: builtPolicy.policy, enabled: true });
      onSaved(saved);
    } catch (caught) {
      setErrors([errorText(caught, 'Unable to save the channel.')]);
    } finally {
      setSaving(false);
    }
  };

  return <div className="space-y-4 border-t border-border/70 bg-muted/20 p-4">
    {errors.length ? <ErrorBanner message={errors.join(' ')} /> : null}
    {!editing ? <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Applies to">
        <select className="field" value={botId ?? ''} onChange={(event) => setBotId(event.target.value || null)}>
          <option value="">Global (every bot)</option>
          {bots.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}
        </select>
      </Field>
      <Field label="Kind">
        <select className="field" value={activeKind} onChange={(event) => { setKind(event.target.value); setConfig(configToDraft(event.target.value, null)); }} disabled={!kinds.length}>
          {kinds.length ? kinds.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.label}</option>) : <option value="">Every kind is already configured here</option>}
        </select>
      </Field>
    </div> : null}

    {activeKind ? <p className="text-[11px] text-muted-foreground">{meta.description}</p> : null}

    {activeKind === 'webpush' ? <p className="rounded-lg border border-border/70 bg-background px-3 py-2 text-[11px] text-muted-foreground">No configuration needed. Web push uses the browser push subscriptions already registered for your account. If none exist, a test will report <code>no_subscriptions</code>; enable notifications in Settings → Notifications first.</p> : null}

    {activeKind === 'slack' ? <div className="space-y-3">
      <div className="inline-flex rounded-lg border border-border bg-background p-0.5" role="group" aria-label="Slack delivery method">
        {(['bot', 'webhook'] as const).map((mode) => <button key={mode} type="button" aria-pressed={config.slackMode === mode} onClick={() => setCfg('slackMode', mode)} className={`rounded-md px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${config.slackMode === mode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{mode === 'bot' ? 'Bot token + channel' : 'Incoming webhook'}</button>)}
      </div>
      {config.slackMode === 'bot' ? <div className="grid gap-3 sm:grid-cols-2">
        <SecretField label="Bot token secret" value={config.tokenRef} onChange={(value) => setCfg('tokenRef', value)} />
        <Field label="Channel id" hint="For example C0123456789 (not the channel name)."><input className="field" value={config.channelId} onChange={(event) => setCfg('channelId', event.target.value)} placeholder="C0123456789" /></Field>
      </div> : <SecretField label="Webhook URL secret" value={config.webhookUrlRef} onChange={(value) => setCfg('webhookUrlRef', value)} hint="Store the incoming-webhook URL as a vault secret and reference it here." />}
    </div> : null}

    {activeKind === 'telegram' ? <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <SecretField label="Bot token secret" value={config.tokenRef} onChange={(value) => setCfg('tokenRef', value)} />
        <Field label="Chat id" hint="The numeric id of the chat to message."><input className="field" value={config.chatId} onChange={(event) => setCfg('chatId', event.target.value)} placeholder="123456789" inputMode="numeric" /></Field>
      </div>
      <div className="rounded-lg border border-border/70 bg-background p-3">
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={config.inbound} onChange={(event) => setCfg('inbound', event.target.checked)} /><span><span className="font-medium">Accept replies (inbound polling)</span><span className="mt-0.5 block text-[10px] text-muted-foreground">CloudCLI long-polls Telegram for messages you send the bot and routes them to your bots.</span></span></label>
        <p className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-300"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />Security: only messages from the configured chat id are accepted. Anything from another chat is ignored, so keep the chat private and do not reuse a group you do not control.</p>
      </div>
    </div> : null}

    {activeKind === 'email' ? <p className="rounded-lg border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">{EMAIL_DEFERRED_MESSAGE}</p> : null}

    {activeKind === 'slack' || activeKind === 'telegram' ? <Field label="Public base URL for action links (optional)" hint="Overrides the app-wide URL for approve/reject links in this channel's messages. Leave blank to use the default.">
      <input className="field" value={config.actionBaseUrl} onChange={(event) => setCfg('actionBaseUrl', event.target.value)} placeholder="https://bots.example.com" spellCheck={false} />
    </Field> : null}

    {activeKind && activeKind !== 'email' ? <PolicyEditor draft={policy} onChange={setPolicy} global={botId === null} /> : null}

    <div className="flex items-center justify-end gap-2">
      <button type="button" className="button" onClick={onCancel} disabled={saving}>Cancel</button>
      <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving || !activeKind || activeKind === 'email'}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add channel'}</button>
    </div>
  </div>;
}

