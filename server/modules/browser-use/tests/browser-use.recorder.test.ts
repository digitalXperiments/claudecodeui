import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  ActionRecorder,
  MAX_RECORDED_ACTIONS,
  RECORDER_BINDING_NAME,
  RECORDER_SCRIPT,
  type RecordedAction,
} from '@/modules/browser-use/browser-use.recorder.js';
import { browserUseService, browserUseTestHooks, normalizeProfileDir } from '@/modules/browser-use/browser-use.service.js';

// ---- the in-page script, run against a minimal fake DOM --------------------------------------

type FakeEl = Record<string, any>;

function fakeEl(tag: string, attrs: Record<string, string> = {}, extra: FakeEl = {}): FakeEl {
  const el: FakeEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: attrs.id ?? '',
    previousElementSibling: null,
    parentElement: null,
    value: '',
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    ...extra,
  };
  el.closest = () => el;
  return el;
}

function runScript() {
  const handlers: Record<string, Array<(event: any) => void>> = {};
  const windowHandlers: Record<string, Array<() => void>> = {};
  const sent: any[] = [];
  const sandbox: any = {
    window: {
      __cloudcliRecord: (payload: unknown) => { sent.push(payload); },
      addEventListener: (type: string, handler: () => void) => { (windowHandlers[type] ??= []).push(handler); },
    },
    document: { addEventListener: (type: string, handler: (event: any) => void) => { (handlers[type] ??= []).push(handler); } },
  };
  vm.runInNewContext(RECORDER_SCRIPT, sandbox);
  const fire = (type: string, event: any) => (handlers[type] ?? []).forEach((handler) => handler(event));
  return { sent, fire, sandbox, windowHandlers };
}

test('recorder script: clicks, typed fields (redacted at the source for passwords), selects and Enter', () => {
  const { sent, fire } = runScript();

  const email = fakeEl('input', { type: 'email', name: 'email', 'aria-label': 'Work email' });
  email.value = 'ram@example.com';
  fire('input', { target: email });
  fire('input', { target: email });
  fire('focusout', { target: email });
  assert.equal(sent.length, 1, 'repeated input events for one field flush once');
  assert.deepEqual(
    { kind: sent[0].kind, selector: sent[0].selector, label: sent[0].label, value: sent[0].value, sensitive: sent[0].sensitive },
    { kind: 'fill', selector: 'input[name="email"]', label: 'Work email', value: 'ram@example.com', sensitive: false },
  );

  const password = fakeEl('input', { type: 'password', name: 'pw' });
  password.value = 'hunter2-never-leaves-the-page';
  fire('input', { target: password });
  fire('focusout', { target: password });
  assert.equal(sent[1].sensitive, true);
  assert.equal(sent[1].value, null);
  assert.equal(JSON.stringify(sent).includes('hunter2'), false);

  // name hints count even without type=password
  const token = fakeEl('input', { type: 'text', name: 'api_token' });
  token.value = 'tok_123';
  fire('input', { target: token });
  fire('focusout', { target: token });
  assert.equal(sent[2].sensitive, true);
  assert.equal(sent[2].value, null);

  const button = fakeEl('button', { 'data-testid': 'go' }, { innerText: '  Sign   in ' });
  fire('click', { target: button });
  assert.deepEqual({ kind: sent[3].kind, selector: sent[3].selector, text: sent[3].text, tag: sent[3].tag }, { kind: 'click', selector: '[data-testid="go"]', text: 'Sign in', tag: 'button' });

  // clicking into a text field is focus, not a step
  fire('click', { target: fakeEl('input', { type: 'text', name: 'q' }) });
  assert.equal(sent.length, 4);

  const region = fakeEl('select', { name: 'region' }, { options: [{ text: 'UAE' }, { text: 'KSA' }], selectedIndex: 1, value: 'ksa' });
  fire('change', { target: region });
  assert.deepEqual({ kind: sent[4].kind, value: sent[4].value }, { kind: 'select', value: 'KSA' });

  const note = fakeEl('textarea', { name: 'note' });
  note.value = 'hello';
  fire('input', { target: note });
  fire('keydown', { key: 'a', target: note });
  assert.equal(sent.length, 5, 'only Enter is recorded');
  fire('keydown', { key: 'Enter', target: note });
  assert.equal(sent[5].kind, 'fill', 'pending typing is flushed before the key');
  assert.deepEqual({ kind: sent[6].kind, key: sent[6].key, selector: sent[6].selector }, { kind: 'press', key: 'Enter', selector: 'textarea[name="note"]' });
});

test('recorder script: elements without stable attributes get a short nth-of-type path, and it installs once', () => {
  const { sent, fire, sandbox } = runScript();
  const body = fakeEl('body');
  const list = fakeEl('ul', {}, { parentElement: body });
  const first = fakeEl('li', {}, { parentElement: list });
  const second = fakeEl('li', {}, { parentElement: list, previousElementSibling: first, innerText: 'Second' });
  fire('click', { target: second });
  assert.equal(sent[0].selector, 'body:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(2)');
  vm.runInNewContext(RECORDER_SCRIPT, sandbox);
  fire('click', { target: second });
  assert.equal(sent.length, 2, 'a second injection does not double-register handlers');
});

// ---- the server-side recorder ----------------------------------------------------------------

test('ActionRecorder ignores events until started, sanitises payloads and coalesces typing', () => {
  const recorder = new ActionRecorder();
  recorder.handle({ kind: 'click', selector: '#a', text: 'A' });
  recorder.recordNavigation('https://a.test/');
  assert.deepEqual(recorder.snapshot(), []);

  recorder.start();
  recorder.handle({ kind: 'click', selector: `#${'x'.repeat(500)}`, text: 'B'.repeat(300) }, 1_000);
  recorder.handle({ kind: 'fill', selector: 'input', label: 'L', value: 'a', sensitive: false }, 1_001);
  recorder.handle({ kind: 'fill', selector: 'input', label: 'L', value: 'ab', sensitive: false }, 1_002);
  recorder.handle({ kind: 'fill', selector: 'pw', value: 'leak', sensitive: true }, 1_003);
  recorder.handle({ kind: 'fill', selector: '', value: 'no selector' }, 1_004);
  recorder.handle({ kind: 'mystery', selector: 'x' }, 1_005);
  recorder.handle('not an object', 1_006);
  recorder.recordNavigation('javascript:alert(1)', 1_007);
  recorder.recordNavigation('https://a.test/next', 1_500);
  recorder.recordNavigation('https://a.test/next', 1_501);
  recorder.recordNavigation('https://a.test/later', 99_999);

  const actions = recorder.snapshot();
  assert.equal((actions[0] as any).selector.length, 300);
  assert.equal((actions[0] as any).text.length, 100);
  assert.deepEqual(actions.slice(1, 3).map((a) => [a.kind, (a as any).value]), [['fill', 'ab'], ['fill', null]]);
  assert.deepEqual(
    actions.slice(3).map((a) => [a.kind, (a as any).url, (a as any).implied]),
    [
      ['navigate', 'https://a.test/next', true],
      ['navigate', 'https://a.test/later', undefined],
    ],
  );
  assert.equal(JSON.stringify(actions).includes('leak'), false);

  const stopped = recorder.stop();
  assert.equal(stopped.actions.length, actions.length);
  recorder.handle({ kind: 'click', selector: '#late' });
  assert.equal(recorder.snapshot().length, actions.length, 'nothing is recorded after stop');
});

test('ActionRecorder marks a navigation right after an interaction as implied and caps the buffer', () => {
  const recorder = new ActionRecorder();
  recorder.start();
  recorder.handle({ kind: 'click', selector: '#go', text: 'Go' }, 10_000);
  recorder.recordNavigation('https://a.test/result', 11_000);
  assert.equal((recorder.snapshot()[1] as Extract<RecordedAction, { kind: 'navigate' }>).implied, true);
  for (let i = 0; i < MAX_RECORDED_ACTIONS + 50; i += 1) recorder.handle({ kind: 'click', selector: `#b${i}` }, 20_000 + i);
  assert.equal(recorder.snapshot().length, MAX_RECORDED_ACTIONS);
});

// ---- wired through the browser-use service ---------------------------------------------------

function installRecordableSession(id = 'rec-session') {
  const bindings = new Map<string, (source: unknown, payload: unknown) => void>();
  const initScripts: string[] = [];
  const pageHandlers = new Map<string, (frame: unknown) => void>();
  const mainFrame = { url: () => 'https://site.test/start' };
  const evaluated: string[] = [];
  const page = {
    mainFrame: () => mainFrame,
    on: (event: string, handler: (frame: unknown) => void) => { pageHandlers.set(event, handler); },
    off: (event: string) => { pageHandlers.delete(event); },
    evaluate: async (script: string) => { evaluated.push(script); return undefined; },
    screenshot: async () => Buffer.from('x'),
    title: async () => 't',
    url: () => 'https://site.test/start',
    viewportSize: () => ({ width: 800, height: 600 }),
  };
  const context = {
    exposeBinding: async (name: string, handler: (source: unknown, payload: unknown) => void) => { bindings.set(name, handler); },
    addInitScript: async (script: string) => { initScripts.push(script); },
    pages: () => [page],
    on: () => undefined,
    off: () => undefined,
  };
  browserUseTestHooks.installSession({
    id, ownerId: 'agent', createdBy: 'agent', runtime: 'local', status: 'ready', url: null, title: null,
    screenshotDataUrl: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastAction: null, message: null, profileName: null, viewport: { width: 800, height: 600 }, cursor: null,
    workspacePath: '/tmp/cloudcli-browser-test', networkRecording: false, controller: 'human',
  }, { page, context });
  return { bindings, initScripts, pageHandlers, mainFrame, evaluated };
}

test('browser-use service records actions through the context binding and page navigations', async () => {
  const fake = installRecordableSession();
  try {
    await browserUseService.startActionRecording('rec-session');
    const binding = fake.bindings.get(RECORDER_BINDING_NAME);
    assert.ok(binding, 'the recorder binding is exposed on the context');
    assert.equal(fake.initScripts[0], RECORDER_SCRIPT);
    assert.equal(fake.evaluated[0], RECORDER_SCRIPT, 'already-open pages are instrumented too');

    binding!({}, { kind: 'click', selector: '#buy', text: 'Buy' });
    fake.pageHandlers.get('framenavigated')!({ url: () => 'https://elsewhere.test/iframe' });
    fake.pageHandlers.get('framenavigated')!(fake.mainFrame);
    const stopped = await browserUseService.stopActionRecording('rec-session');
    assert.deepEqual(stopped.actions.map((a) => a.kind), ['click', 'navigate'], 'sub-frame navigations are ignored');
    assert.equal((stopped.actions[1] as any).url, 'https://site.test/start');

    // A second run re-uses the binding (Playwright rejects a duplicate) and starts clean.
    await browserUseService.startActionRecording('rec-session');
    assert.equal(fake.initScripts.length, 1);
    assert.equal((await browserUseService.stopActionRecording('rec-session')).actions.length, 0);
    await assert.rejects(browserUseService.stopActionRecording('missing-session'), /not found/);
  } finally {
    browserUseTestHooks.clear();
  }
});

test('browser-use service refuses to record without a real browser context', async () => {
  browserUseTestHooks.installSession({
    id: 'no-context', ownerId: 'agent', createdBy: 'agent', runtime: 'local', status: 'ready', url: null, title: null,
    screenshotDataUrl: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastAction: null, message: null, profileName: null, viewport: null, cursor: null,
    workspacePath: '/tmp/cloudcli-browser-test', networkRecording: false, controller: 'human',
  }, { page: {} });
  try {
    await assert.rejects(browserUseService.startActionRecording('no-context'), /not available/);
    await assert.rejects(browserUseService.stopActionRecording('no-context'), /not being recorded/);
  } finally {
    browserUseTestHooks.clear();
  }
});

test('normalizeProfileDir only accepts absolute directories named browser-profile', () => {
  assert.equal(normalizeProfileDir(undefined), null);
  assert.equal(normalizeProfileDir('  '), null);
  assert.equal(normalizeProfileDir('/tmp/bots/b1/home/browser-profile'), path.resolve('/tmp/bots/b1/home/browser-profile'));
  assert.throws(() => normalizeProfileDir('relative/browser-profile'), /absolute/);
  assert.throws(() => normalizeProfileDir('/etc'), /named "browser-profile"/);
  assert.throws(() => normalizeProfileDir('/tmp/browser-profile/../..'), /named "browser-profile"/);
});
