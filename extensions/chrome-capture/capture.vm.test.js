// chrome.scripting.executeScript({ func }) serializes ONLY the function's own
// source (Function.prototype.toString) and re-evaluates it in the page's
// isolated world -- none of this module's other top-level bindings travel
// with it. These tests reproduce that isolation with node:vm so a helper
// reference that leaks outside an exported function's own body throws a
// ReferenceError here, the same way it would silently break in a real page.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { captureSelectedText, selectElementOnPage, startRecording, stopRecording } from './capture.js';

function makeElement({ tagName = 'DIV', type, name, id, attrs = {}, parentElement = null, text = '' } = {}) {
  return {
    nodeType: 1,
    tagName,
    type,
    name,
    id,
    autocomplete: attrs.autocomplete,
    parentElement,
    innerText: text,
    getAttribute(key) { return attrs[key] ?? null; },
    hasAttribute(key) { return Object.prototype.hasOwnProperty.call(attrs, key); },
    closest() { return null; },
    cloneNode() { return makeElement({ tagName, type, name, id, attrs, text }); },
    querySelectorAll() { return []; },
  };
}

function makeEventTarget(extra = {}) {
  const listeners = {};
  return {
    ...extra,
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) { listeners[type] = (listeners[type] || []).filter((h) => h !== handler); },
    dispatch(type, event) { (listeners[type] || []).slice().forEach((handler) => handler(event)); },
  };
}

/** Runs `fn` with only the given page globals in scope -- no sibling helpers. */
function runIsolated(fn, { window: fakeWindow, document: fakeDocument, location: fakeLocation } = {}) {
  const context = vm.createContext({
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: (value) => value },
    Date, Math, Promise,
    window: fakeWindow,
    document: fakeDocument,
    location: fakeLocation,
  });
  return new vm.Script(`(${fn.toString()})`).runInContext(context)();
}

test('captureSelectedText (isolated): excludes text selected inside a sensitive ancestor', () => {
  const sensitiveContainer = makeElement({ attrs: { 'data-sensitive': '' } });
  const anchor = makeElement({ tagName: 'SPAN', parentElement: sensitiveContainer });
  const result = runIsolated(captureSelectedText, {
    window: { getSelection: () => ({ anchorNode: { parentElement: anchor }, rangeCount: 0, toString: () => 'topSecret123' }) },
    location: { href: 'https://example.test/secure' },
  });
  assert.equal(result.text, '');
  assert.equal(result.source, 'https://example.test/secure');
});

test('captureSelectedText (isolated): keeps text selected outside any sensitive ancestor', () => {
  const container = makeElement({});
  const anchor = makeElement({ tagName: 'SPAN', parentElement: container });
  const result = runIsolated(captureSelectedText, {
    window: { getSelection: () => ({ anchorNode: { parentElement: anchor }, rangeCount: 0, toString: () => 'hello world' }) },
    location: { href: 'https://example.test/page' },
  });
  assert.equal(result.text, 'hello world');
});

test('selectElementOnPage (isolated): marks a captured password field as sensitive with no text', async () => {
  const fakeDocument = makeEventTarget();
  const pending = runIsolated(selectElementOnPage, { document: fakeDocument });
  const passwordInput = makeElement({ tagName: 'INPUT', type: 'password', text: 'hunter2' });
  fakeDocument.dispatch('click', { target: passwordInput, preventDefault() {}, stopPropagation() {} });
  const result = await pending;
  assert.equal(result.sensitive, true);
  assert.equal(result.text, '');
});

test('selectElementOnPage (isolated): describes a normal element with its visible text', async () => {
  const fakeDocument = makeEventTarget();
  const pending = runIsolated(selectElementOnPage, { document: fakeDocument });
  const button = makeElement({ tagName: 'BUTTON', text: 'Submit' });
  fakeDocument.dispatch('click', { target: button, preventDefault() {}, stopPropagation() {} });
  const result = await pending;
  assert.equal(result.sensitive, false);
  assert.equal(result.text, 'Submit');
});

test('startRecording/stopRecording (isolated): records clicks but drops input on sensitive fields', () => {
  const fakeDocument = makeEventTarget();
  const fakeWindow = makeEventTarget({ scrollX: 0, scrollY: 0 });
  const started = runIsolated(startRecording, { window: fakeWindow, document: fakeDocument });
  assert.equal(started.started, true);

  const button = makeElement({ tagName: 'BUTTON', id: 'submit' });
  fakeDocument.dispatch('click', { clientX: 12, clientY: 34, target: button });

  const passwordInput = makeElement({ tagName: 'INPUT', type: 'password' });
  Object.defineProperty(passwordInput, 'value', { value: 'hunter2' });
  fakeDocument.dispatch('input', { target: passwordInput });

  const stopped = runIsolated(stopRecording, { window: fakeWindow });
  assert.equal(stopped.events.length, 1);
  assert.equal(stopped.events[0].type, 'click');
});
