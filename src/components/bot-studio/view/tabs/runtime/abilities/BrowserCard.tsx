import { Check, Clock, ExternalLink, Globe, LogOut, Loader2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotBrowserStatus } from '../../../../types/botRuntime';
import { ErrorLine, WarnLine } from '../panel/Panel';
import { useRemote } from '../panel/useRemote';

// Lazy: the browser panel is heavy and only needed while a sign-in session is open.
const BrowserUsePanel = lazy(() => import('../../../../../browser-use').then((module) => ({ default: module.BrowserUsePanel })));

import {
  SIGN_IN_EXPIRED_MESSAGE, browserErrorMessage, browserStatusLine, normalizeSignInUrl, pendingSignIn, resolveViewHint, signInCountdown,
  type PendingSignIn, type ViewTarget,
} from './abilitiesModel';

const storageKey = (botId: string) => `cloudcli-bot-signin:${botId}`;

function loadPending(botId: string): PendingSignIn | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(botId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSignIn>;
    if (typeof parsed.sessionId !== 'string' || typeof parsed.url !== 'string') return null;
    return { sessionId: parsed.sessionId, url: parsed.url, target: parsed.target ?? resolveViewHint(null, ''), expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null };
  } catch { return null; }
}

function savePending(botId: string, value: PendingSignIn | null): void {
  try {
    if (value) window.sessionStorage.setItem(storageKey(botId), JSON.stringify(value));
    else window.sessionStorage.removeItem(storageKey(botId));
  } catch { /* storage is optional */ }
}

function showTarget(target: ViewTarget): void {
  if (target.kind === 'event') window.dispatchEvent(new CustomEvent(target.name, { detail: target.detail }));
}

function SessionView({ target }: { target: ViewTarget }) {
  if (target.kind === 'embed') {
    return (
      <div className="h-[560px] overflow-hidden rounded-lg border border-border/70 bg-background">
        <Suspense fallback={<p className="p-3 text-xs text-muted-foreground">Opening the bot's browser…</p>}>
          <BrowserUsePanel isVisible sessionId={target.sessionId} />
        </Suspense>
      </div>
    );
  }
  if (target.kind === 'route') {
    return <a className="button inline-flex" href={target.path} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open the browser session</a>;
  }
  if (target.kind === 'event') {
    return <button type="button" className="button" onClick={() => showTarget(target)}><ExternalLink className="h-3.5 w-3.5" />Show the browser session</button>;
  }
  return <p className="text-xs leading-relaxed text-foreground">{target.text}</p>;
}

/** The bot's own browser: status, "Sign in as this bot", "I'm done signing in" and "Sign the bot out everywhere". */
export default function BrowserCard({ botId, botTitle, initial, onChanged }: { botId: string; botTitle: string; initial: BotBrowserStatus | null; onChanged: () => void }) {
  const remote = useRemote(() => botRuntimeApi.browser.status(botId), botId);
  const status = remote.data ?? initial;
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<PendingSignIn | null>(() => loadPending(botId));
  const [busy, setBusy] = useState<'start' | 'finish' | 'signout' | 'extend' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setPending(loadPending(botId)); }, [botId]);

  // The server is the clock; take the later of its expiry and the one saved with the start/extend (the other may be stale).
  const serverExpiry = status?.sign_in && pending && status.sign_in.session_id === pending.sessionId ? status.sign_in.expires_at : null;
  const latestExpiry = [serverExpiry, pending?.expiresAt].filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  const countdown = pending ? signInCountdown(latestExpiry, now) : null;
  const expiredSeen = Boolean(countdown?.expired);
  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  // Once the time is up the server closes the browser (cookies flushed); drop the stale window and say so.
  useEffect(() => {
    if (!expiredSeen) return;
    setPending(null);
    savePending(botId, null);
    setNotice(null);
    setError(SIGN_IN_EXPIRED_MESSAGE);
    void remote.reload();
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiredSeen, botId]);
  // The server closed a window while this card was not looking (reload, another tab).
  const closedByServer = !pending && status?.sign_in_expired ? SIGN_IN_EXPIRED_MESSAGE : null;

  const extend = async () => {
    if (!pending) return;
    setError(null);
    setBusy('extend');
    try {
      const result = await botRuntimeApi.browser.extendSignIn(botId, pending.sessionId);
      const next = { ...pending, expiresAt: result.expiresAt };
      setPending(next);
      savePending(botId, next);
      setNow(Date.now());
      setNotice(result.atLimit ? 'Added 30 minutes. This is the longest the window can stay open (2 hours).' : 'Added 30 minutes.');
      await remote.reload();
    } catch (caught) {
      setError(browserErrorMessage(caught, 'extend'));
    } finally { setBusy(null); }
  };

  const start = async () => {
    setError(null);
    setNotice(null);
    const cleaned = normalizeSignInUrl(url);
    if ('error' in cleaned) { setError(cleaned.error); return; }
    setBusy('start');
    try {
      const result = await botRuntimeApi.browser.signIn(botId, cleaned.url);
      const next = pendingSignIn(result, cleaned.url, botTitle);
      setPending(next);
      savePending(botId, next);
      showTarget(next.target);
    } catch (caught) {
      setError(browserErrorMessage(caught, 'sign-in'));
    } finally { setBusy(null); }
  };

  const finish = async () => {
    if (!pending) return;
    setError(null);
    setBusy('finish');
    try {
      await botRuntimeApi.browser.finishSignIn(botId, pending.sessionId);
      setPending(null);
      savePending(botId, null);
      setNotice('Saved. The bot will use these logins from now on.');
      setUrl('');
      await remote.reload();
      onChanged();
    } catch (caught) {
      const message = browserErrorMessage(caught, 'finish');
      setError(message);
      if ((caught as { status?: unknown } | null)?.status === 409) { setPending(null); savePending(botId, null); }
    } finally { setBusy(null); }
  };

  const signOut = async () => {
    if (!window.confirm(`Sign ${botTitle || 'this bot'} out of every website? It will have to be signed in again before it can use them.`)) return;
    setError(null);
    setNotice(null);
    setBusy('signout');
    try {
      await botRuntimeApi.browser.signOutEverywhere(botId);
      setPending(null);
      savePending(botId, null);
      setNotice('Done. The bot is signed out of every site.');
      await remote.reload();
      onChanged();
    } catch (caught) {
      setError(browserErrorMessage(caught, 'sign-out'));
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-4">
      <div>
        <p className="flex items-center gap-1.5 text-xs font-semibold"><Globe className="h-3.5 w-3.5 text-primary" aria-hidden="true" />Websites it is signed in to</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Some jobs need a website that has no app. Sign in once as the bot (you do the typing, it never sees your password) and it can use the site later. The bot has its own separate browser, so your own logins stay private.</p>
      </div>
      <p className="text-xs" role="status">{browserStatusLine(status)}</p>
      {remote.error && !status ? <p className="text-[11px] text-muted-foreground">Could not check the browser profile ({remote.error}).</p> : null}

      {pending ? (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
          <p className="text-xs font-semibold">Signing in to {pending.url}</p>
          <SessionView target={pending.target} />
          <p className="text-[11px] text-muted-foreground">Sign in in the browser, then press the button below. The bot cannot start while you are signing in.</p>
          {countdown ? (
            <p className={countdown.low ? 'flex flex-wrap items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-300' : 'flex items-center gap-1.5 text-[11px] text-muted-foreground'} role="status" aria-live={countdown.low ? 'assertive' : 'off'}>
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{countdown.label}{countdown.low ? ' \u2014 the browser closes by itself when the time is up.' : ''}</span>
              {countdown.low ? (
                <button type="button" className="button" disabled={busy !== null} onClick={() => void extend()}>
                  {busy === 'extend' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}I need more time
                </button>
              ) : null}
            </p>
          ) : null}
          <button type="button" className="button button-primary" disabled={busy !== null} onClick={() => void finish()}>
            {busy === 'finish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}I'm done signing in
          </button>
        </div>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void start(); }} aria-label="Sign in as this bot">
          <label className="min-w-0 flex-[1_1_16rem] text-[11px] text-muted-foreground">
            Site to sign in to
            <input className="field mt-1 h-9 w-full" placeholder="https://mail.google.com" aria-label="Site to sign in to" inputMode="url" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <button type="submit" className="button button-primary" disabled={busy !== null}>{busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Sign in as this bot</button>
        </form>
      )}

      <ErrorLine message={error ?? closedByServer} />
      {notice ? <p role="status" className="text-[11px] text-emerald-700 dark:text-emerald-300">{notice}</p> : null}

      {status?.profile_exists ? (
        <div className="border-t border-border/50 pt-3">
          <button type="button" className="button text-destructive" disabled={busy !== null} onClick={() => void signOut()}><LogOut className="h-3.5 w-3.5" />Sign the bot out everywhere</button>
          <WarnLine>This deletes the bot's browser, including every saved login. Your own browser is not affected.</WarnLine>
        </div>
      ) : null}
    </div>
  );
}
