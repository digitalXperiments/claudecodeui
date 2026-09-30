import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  ActionRecorder,
  MAX_RECORDED_ACTIONS,
  RECORDER_BINDING_NAME,
  looksSensitiveField,
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
  return { bindings, initScripts, pageHandlers, mainFrame, evaluated, page };
}

test('browser-use service records actions through the context binding and page navigations', async () => {
  const fake = installRecordableSession();
  try {
    await browserUseService.startActionRecording('rec-session');
    const binding = fake.bindings.get(RECORDER_BINDING_NAME);
    assert.ok(binding, 'the recorder binding is exposed on the context');
    assert.equal(fake.initScripts[0], RECORDER_SCRIPT);
    assert.equal(fake.evaluated[0], RECORDER_SCRIPT, 'already-open pages are instrumented too');

    binding!({ page: fake.page, frame: fake.mainFrame }, { kind: 'click', selector: '#buy', text: 'Buy' });
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

// ---- wave E: broader sensitivity, form context, source and stop checks -------------------------------

function sendFor(el: FakeEl): any {
  const { sent, fire } = runScript();
  el.value = 'typed-secret-value';
  fire('input', { target: el });
  fire('focusout', { target: el });
  return sent[0];
}

test('recorder script: credential-ish hints are sensitive and never leave the page', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['pwd', { type: 'text', name: 'pwd' }],
    ['pin', { type: 'text', name: 'pin' }],
    ['passcode', { type: 'text', name: 'passcode' }],
    ['apikey', { type: 'text', name: 'apikey' }],
    ['api_key', { type: 'text', name: 'api_key' }],
    ['camel apiKey', { type: 'text', name: 'apiKey' }],
    ['key', { type: 'text', name: 'key' }],
    ['ssn', { type: 'text', name: 'ssn' }],
    ['iban', { type: 'text', name: 'iban' }],
    ['account', { type: 'text', name: 'account' }],
    ['cc- in id', { type: 'text', id: 'cc-number' }],
    ['autocomplete one-time-code', { type: 'text', name: 'c', autocomplete: 'one-time-code' }],
    ['autocomplete cc-number', { type: 'text', name: 'c', autocomplete: 'cc-number' }],
    ['autocomplete current-password', { type: 'text', name: 'c', autocomplete: 'current-password' }],
    ['autocomplete new-password', { type: 'text', name: 'c', autocomplete: 'new-password' }],
    ['placeholder hint', { type: 'text', name: 'c', placeholder: 'Enter your PIN' }],
  ];
  for (const [label, attrs] of cases) {
    const report = sendFor(fakeEl('input', attrs));
    assert.equal(report.sensitive, true, label);
    assert.equal(report.value, null, label);
  }
  // Short words match whole words only.
  for (const attrs of [{ type: 'text', name: 'shipping' }, { type: 'text', name: 'classname' }, { type: 'text', name: 'keyword' }, { type: 'text', name: 'nickname' }]) {
    const report = sendFor(fakeEl('input', attrs));
    assert.equal(report.sensitive, false, attrs.name);
    assert.equal(report.value, 'typed-secret-value');
  }
});

test('recorder script: any text input in a form that also has a password field is sensitive; numeric inputmode too', () => {
  const passwordForm = { querySelector: (selector: string) => (selector.includes('password') ? {} : null), tagName: 'FORM' };
  const plainForm = { querySelector: () => null, tagName: 'FORM' };

  const username = fakeEl('input', { type: 'text', name: 'username' }, { form: passwordForm });
  const report = sendFor(username);
  assert.equal(report.sensitive, true);
  assert.equal(report.value, null);

  const numeric = fakeEl('input', { type: 'text', name: 'digits', inputmode: 'numeric' }, { form: passwordForm });
  assert.equal(sendFor(numeric).sensitive, true);

  const textarea = fakeEl('textarea', { name: 'about' }, { form: passwordForm });
  assert.equal(sendFor(textarea).sensitive, true);

  const search = fakeEl('input', { type: 'text', name: 'q' }, { form: plainForm });
  assert.equal(sendFor(search).sensitive, false);
  const noForm = fakeEl('input', { type: 'text', name: 'q' });
  assert.equal(sendFor(noForm).sensitive, false);
});

test('ActionRecorder.handle flags credential-like fields itself; a page cannot un-flag them', () => {
  const recorder = new ActionRecorder();
  recorder.start();
  recorder.handle({ kind: 'fill', selector: 'input[name="pin"]', name: 'pin', label: 'Code', value: '1234', sensitive: false }, 1);
  recorder.handle({ kind: 'fill', selector: 'input[name="iban"]', name: 'iban', value: 'GB00', sensitive: false, inputType: 'text' }, 2);
  recorder.handle({ kind: 'fill', selector: 'input[name="city"]', name: 'city', value: 'Riyadh', sensitive: false }, 3);
  recorder.handle({ kind: 'select', selector: 'select[name="account"]', label: 'Account', value: 'Savings 12345' }, 4);
  const actions = recorder.snapshot() as any[];
  assert.deepEqual(actions.slice(0, 3).map((a) => [a.sensitive, a.value]), [[true, null], [true, null], [false, 'Riyadh']]);
  assert.equal(actions[3].value, null, 'a credential-like select keeps no value');
  assert.equal(JSON.stringify(actions).includes('1234'), false);

  assert.equal(looksSensitiveField({ name: 'new_password' }), true);
  assert.equal(looksSensitiveField({ inputType: 'password' }), true);
  assert.equal(looksSensitiveField({ label: 'Keyword' }), false);
  assert.equal(looksSensitiveField({ selector: 'input[name="ssn"]' }), true);
  assert.equal(looksSensitiveField({}), false);
});

test('service recording only believes the top frame of the page it started on, and ignores bindings after stop', async () => {
  const fake = installRecordableSession('rec-origin');
  try {
    await browserUseService.startActionRecording('rec-origin');
    const binding = fake.bindings.get(RECORDER_BINDING_NAME)!;
    const click = (selector: string) => ({ kind: 'click', selector, text: selector });

    const otherPage = { mainFrame: () => ({ url: () => 'https://evil.test/' }) };
    binding({ page: fake.page, frame: fake.mainFrame }, click('#genuine'));
    binding({ page: otherPage, frame: otherPage.mainFrame() }, click('#other-tab'));
    binding({ page: fake.page, frame: { url: () => 'https://ads.test/frame' } }, click('#iframe'));
    binding({}, click('#no-source'));
    binding(undefined, click('#undefined-source'));

    // A cross-origin top-frame navigation of the start page is still the start page.
    const nav = fake.pageHandlers.get('framenavigated')!;
    (fake.mainFrame as { url: () => string }).url = () => 'https://idp.test/login';
    nav(fake.mainFrame);
    binding({ page: fake.page, frame: fake.mainFrame }, click('#on-idp'));

    const stopped = await browserUseService.stopActionRecording('rec-origin');
    assert.deepEqual(
      stopped.actions.filter((a) => a.kind === 'click').map((a) => (a as { selector: string }).selector),
      ['#genuine', '#on-idp'],
    );

    // After stop the still-exposed binding does nothing, even from the right page.
    binding({ page: fake.page, frame: fake.mainFrame }, click('#late'));
    await browserUseService.startActionRecording('rec-origin');
    assert.equal((await browserUseService.stopActionRecording('rec-origin')).actions.length, 0);
    binding({ page: fake.page, frame: fake.mainFrame }, click('#late-again'));
    const recorder = new ActionRecorder();
    recorder.start();
    recorder.handle(click('#kept'));
    recorder.stop();
    recorder.handle(click('#late'));
    recorder.recordNavigation('https://late.test/');
    assert.equal(recorder.snapshot().length, 1);
  } finally {
    browserUseTestHooks.clear();
  }
});

test('describeAgentSession exposes owner profile and driver server-side only; public sessions never carry the profile path', async () => {
  browserUseTestHooks.installSession({
    id: 'owned-session', ownerId: 'agent', createdBy: 'agent', runtime: 'local', status: 'ready', url: null, title: null,
    screenshotDataUrl: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastAction: null, message: null, profileName: 'bot-profile', viewport: null, cursor: null,
    workspacePath: '/tmp/cloudcli-browser-test', networkRecording: false, controller: 'agent',
    profileDir: '/tmp/bots/b1/home/browser-profile',
  }, { page: {} });
  try {
    assert.deepEqual(await browserUseService.describeAgentSession('owned-session'), {
      profileDir: '/tmp/bots/b1/home/browser-profile',
      controller: 'agent',
    });
    await browserUseService.takeHumanControl('owned-session');
    assert.equal((await browserUseService.describeAgentSession('owned-session')).controller, 'human');
    const listed = await browserUseService.listSessions();
    assert.equal(JSON.stringify(listed).includes('browser-profile'), false);
    const taken = await browserUseService.takeHumanControl('owned-session');
    assert.equal('profileDir' in taken, false);
    await assert.rejects(browserUseService.describeAgentSession('missing'), /not found/);
  } finally {
    browserUseTestHooks.clear();
  }
});
