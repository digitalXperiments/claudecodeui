/**
 * Semantic action recorder for Browser sessions (used by bot "teach mode").
 *
 * An in-page script reports what a person does (clicks, typed values, selects, Enter) with a
 * stable selector and a human label; Playwright `framenavigated` events add the navigations. The
 * buffer is bounded, lives only in memory, and password-like fields are never sent out of the page.
 * Input values are kept here only so a caller can explicitly mark a field safe; callers should
 * expose `redactedActions()` unless they did.
 */

export type RecordedAction =
  | { kind: 'navigate'; url: string; at: number; implied?: boolean }
  | { kind: 'click'; selector: string; text?: string; tag?: string; at: number }
  | { kind: 'fill'; selector: string; label?: string; name?: string; inputType?: string; value: string | null; sensitive: boolean; at: number }
  | { kind: 'select'; selector: string; label?: string; value: string | null; at: number }
  | { kind: 'press'; key: string; selector?: string; at: number };

export const RECORDER_BINDING_NAME = '__cloudcliRecord';
export const MAX_RECORDED_ACTIONS = 400;
/** A navigation this soon after an interaction is the interaction's result, not a separate step. */
const IMPLIED_NAVIGATION_MS = 4_000;

const clip = (value: unknown, max: number): string =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Runs inside the page. Plain ES5-ish source: it must survive being injected verbatim. */
export const RECORDER_SCRIPT = String.raw`(() => {
  if (window.__cloudcliRecorderInstalled) return;
  window.__cloudcliRecorderInstalled = true;
  var send = function (event) { try { window.__cloudcliRecord(event); } catch (e) {} };
  var clip = function (value, max) {
    value = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max) : value;
  };
  var esc = function (value) { return String(value).replace(/["\\]/g, '\\$&'); };
  var attr = function (el, name) { return el.getAttribute ? el.getAttribute(name) : null; };
  var selectorFor = function (el) {
    if (!el || el.nodeType !== 1) return '';
    var tag = String(el.tagName).toLowerCase();
    var testId = attr(el, 'data-testid') || attr(el, 'data-test');
    if (testId) return '[data-testid="' + esc(testId) + '"]';
    if (el.id) return tag + '[id="' + esc(el.id) + '"]';
    var name = attr(el, 'name');
    if (name) return tag + '[name="' + esc(name) + '"]';
    var aria = attr(el, 'aria-label');
    if (aria) return tag + '[aria-label="' + esc(aria) + '"]';
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      var nodeTag = String(node.tagName).toLowerCase();
      var index = 1;
      var sibling = node.previousElementSibling;
      while (sibling) { if (sibling.tagName === node.tagName) index += 1; sibling = sibling.previousElementSibling; }
      parts.unshift(nodeTag + ':nth-of-type(' + index + ')');
      if (nodeTag === 'body') break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  var labelFor = function (el) {
    var label = attr(el, 'aria-label') || attr(el, 'placeholder');
    if (!label && el.labels && el.labels.length) label = el.labels[0].innerText || el.labels[0].textContent;
    return clip(label || attr(el, 'name') || '', 100);
  };
  var isSensitive = function (el) {
    var type = String(attr(el, 'type') || '').toLowerCase();
    var auto = String(attr(el, 'autocomplete') || '').toLowerCase();
    var hint = String(attr(el, 'name') || '') + ' ' + String(el.id || '');
    return type === 'password' || auto.indexOf('password') >= 0 || auto.indexOf('cc-') === 0 ||
      auto.indexOf('one-time-code') >= 0 || /pass|secret|token|otp|cvv|cvc|card/i.test(hint);
  };
  var isTextField = function (el) {
    var tag = String(el.tagName).toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return el.isContentEditable === true;
    var type = String(attr(el, 'type') || 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].indexOf(type) < 0;
  };
  var pending = [];
  var flush = function () {
    while (pending.length) {
      var el = pending.shift();
      var sensitive = isSensitive(el);
      send({
        kind: 'fill', selector: selectorFor(el), label: labelFor(el), name: clip(attr(el, 'name') || '', 60),
        inputType: clip(attr(el, 'type') || el.tagName, 30), sensitive: sensitive,
        value: sensitive ? null : String(el.value != null ? el.value : (el.textContent || '')).slice(0, 2000)
      });
    }
  };
  document.addEventListener('input', function (event) {
    var el = event.target;
    if (el && el.nodeType === 1 && isTextField(el) && pending.indexOf(el) < 0) pending.push(el);
  }, true);
  document.addEventListener('focusout', flush, true);
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (String(el.tagName).toLowerCase() === 'select') {
      flush();
      var option = el.options && el.options[el.selectedIndex];
      send({ kind: 'select', selector: selectorFor(el), label: labelFor(el), value: isSensitive(el) ? null : clip(option ? option.text : el.value, 200) });
    } else { flush(); }
  }, true);
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || target.nodeType !== 1) return;
    flush();
    var el = target.closest ? (target.closest('a,button,[role=button],input,select,textarea,label,summary,[onclick]') || target) : target;
    if (isTextField(el)) return;
    send({ kind: 'click', selector: selectorFor(el), text: clip(el.innerText || el.textContent || attr(el, 'aria-label') || attr(el, 'value') || '', 100), tag: String(el.tagName).toLowerCase() });
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    flush();
    var el = event.target && event.target.nodeType === 1 ? event.target : null;
    send({ kind: 'press', key: 'Enter', selector: el ? selectorFor(el) : '' });
  }, true);
  window.addEventListener('pagehide', flush, true);
})();`;

type Frame = unknown;
type PageLike = {
  on?: (event: string, handler: (...args: any[]) => void) => unknown;
  off?: (event: string, handler: (...args: any[]) => void) => unknown;
  mainFrame?: () => Frame;
  evaluate?: (script: string) => Promise<unknown>;
};
type ContextLike = {
  exposeBinding?: (name: string, handler: (source: unknown, payload: unknown) => void) => Promise<unknown>;
  addInitScript?: (script: string) => Promise<unknown>;
  pages?: () => PageLike[];
  on?: (event: string, handler: (...args: any[]) => void) => unknown;
  off?: (event: string, handler: (...args: any[]) => void) => unknown;
};

export class ActionRecorder {
  private attached = false;
  private recording = false;
  private actions: RecordedAction[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private readonly navHandlers = new Map<PageLike, (frame: any) => void>();
  private context: ContextLike | null = null;
  private pageHandler: ((page: PageLike) => void) | null = null;

  isRecording(): boolean {
    return this.recording;
  }

  /** Install the in-page script and navigation listeners once per browser context. */
  async attach(context: ContextLike): Promise<void> {
    if (this.attached) return;
    if (!context?.exposeBinding || !context.addInitScript) {
      throw new Error('This browser runtime cannot record actions (no context binding support).');
    }
    await context.exposeBinding(RECORDER_BINDING_NAME, (_source, payload) => this.handle(payload));
    await context.addInitScript(RECORDER_SCRIPT);
    this.context = context;
    const pages = context.pages?.() ?? [];
    for (const page of pages) {
      this.watchNavigation(page);
      await page.evaluate?.(RECORDER_SCRIPT).catch?.(() => undefined);
    }
    this.pageHandler = (page) => this.watchNavigation(page);
    context.on?.('page', this.pageHandler);
    this.attached = true;
  }

  private watchNavigation(page: PageLike): void {
    if (!page.on || this.navHandlers.has(page)) return;
    const handler = (frame: Frame) => {
      if (page.mainFrame && frame !== page.mainFrame()) return;
      const url = typeof (frame as { url?: () => string })?.url === 'function' ? (frame as { url: () => string }).url() : '';
      this.recordNavigation(url);
    };
    this.navHandlers.set(page, handler);
    page.on('framenavigated', handler);
  }

  start(): void {
    this.actions = [];
    this.startedAt = Date.now();
    this.stoppedAt = 0;
    this.recording = true;
  }

  stop(): { actions: RecordedAction[]; startedAt: number; stoppedAt: number } {
    this.recording = false;
    this.stoppedAt = Date.now();
    return { actions: this.snapshot(), startedAt: this.startedAt, stoppedAt: this.stoppedAt };
  }

  /** Copy of the buffer including raw input values. Do not expose it without redaction. */
  snapshot(): RecordedAction[] {
    return this.actions.map((action) => ({ ...action }));
  }

  dispose(): void {
    this.recording = false;
    for (const [page, handler] of this.navHandlers) page.off?.('framenavigated', handler);
    this.navHandlers.clear();
    if (this.pageHandler) this.context?.off?.('page', this.pageHandler);
    this.pageHandler = null;
    this.actions = [];
  }

  private push(action: RecordedAction): void {
    if (!this.recording) return;
    if (this.actions.length >= MAX_RECORDED_ACTIONS) return;
    this.actions.push(action);
  }

  recordNavigation(rawUrl: string, at = Date.now()): void {
    if (!this.recording) return;
    let url: string;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      url = parsed.toString();
    } catch {
      return;
    }
    const last = this.actions[this.actions.length - 1];
    if (last?.kind === 'navigate' && last.url === url) return;
    const implied = Boolean(last && last.kind !== 'navigate' && at - last.at <= IMPLIED_NAVIGATION_MS);
    this.push({ kind: 'navigate', url, at, ...(implied ? { implied: true } : {}) });
  }

  /** Accepts the untrusted payload the in-page script sends. */
  handle(payload: unknown, at = Date.now()): void {
    if (!this.recording || !payload || typeof payload !== 'object') return;
    const event = payload as Record<string, unknown>;
    const selector = clip(event.selector, 300);
    switch (event.kind) {
      case 'click': {
        if (!selector) return;
        this.push({ kind: 'click', selector, text: clip(event.text, 100) || undefined, tag: clip(event.tag, 20) || undefined, at });
        return;
      }
      case 'fill': {
        if (!selector) return;
        const sensitive = event.sensitive === true;
        const action: RecordedAction = {
          kind: 'fill',
          selector,
          label: clip(event.label, 100) || undefined,
          name: clip(event.name, 60) || undefined,
          inputType: clip(event.inputType, 30) || undefined,
          value: sensitive || typeof event.value !== 'string' ? null : event.value.slice(0, 2_000),
          sensitive,
          at,
        };
        const last = this.actions[this.actions.length - 1];
        // Typing produces several reports for one field; keep the last value.
        if (last?.kind === 'fill' && last.selector === selector) this.actions[this.actions.length - 1] = action;
        else this.push(action);
        return;
      }
      case 'select': {
        if (!selector) return;
        this.push({ kind: 'select', selector, label: clip(event.label, 100) || undefined, value: typeof event.value === 'string' ? clip(event.value, 200) : null, at });
        return;
      }
      case 'press': {
        const key = clip(event.key, 30);
        if (key) this.push({ kind: 'press', key, selector: selector || undefined, at });
        return;
      }
      default:
    }
  }
}
