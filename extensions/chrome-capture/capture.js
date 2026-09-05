// Injected page helpers. Credentials stay in the extension side-panel context.
//
// chrome.scripting.executeScript({ func }) serializes only the function's own
// source (Function.prototype.toString) and re-evaluates it inside the page's
// isolated world — it does not carry along any outer module bindings. Every
// exported entry point below must therefore be fully self-contained: no
// references to the top-level helpers in this file, only to globals that
// exist in the page (window/document/Node/CSS).

export function captureSelectedText() {
  function isSensitiveElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' && ['password', 'hidden'].includes((element.type || '').toLowerCase())) return true;
    if (['input', 'textarea', 'select'].includes(tag)) {
      const hint = [element.name, element.id, element.autocomplete, element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
      if (/(password|passwd|passcode|secret|token|api.?key|access.?key|private.?key|credit.?card|security.?code|cvv|ssn|otp|one.?time)/i.test(hint)) return true;
    }
    return element.hasAttribute('data-sensitive') || element.closest?.('[data-sensitive], [data-private], [aria-hidden="true"]') != null;
  }
  function containsSensitiveAncestor(element) {
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (isSensitiveElement(current)) return true;
      current = current.parentElement;
    }
    return false;
  }
  const selection = window.getSelection();
  const anchor = selection?.anchorNode?.parentElement;
  let sensitive = containsSensitiveAncestor(anchor);
  if (!sensitive && selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    sensitive = containsSensitiveAncestor(range.commonAncestorContainer?.parentElement);
    if (!sensitive) {
      const fragment = range.cloneContents();
      sensitive = [...(fragment.querySelectorAll?.('*') || [])].some(isSensitiveElement);
    }
  }
  return { text: sensitive ? '' : String(selection || '').trim().slice(0, 20000), source: location.href };
}

export async function selectElementOnPage() {
  function isSensitiveElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' && ['password', 'hidden'].includes((element.type || '').toLowerCase())) return true;
    if (['input', 'textarea', 'select'].includes(tag)) {
      const hint = [element.name, element.id, element.autocomplete, element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
      if (/(password|passwd|passcode|secret|token|api.?key|access.?key|private.?key|credit.?card|security.?code|cvv|ssn|otp|one.?time)/i.test(hint)) return true;
    }
    return element.hasAttribute('data-sensitive') || element.closest?.('[data-sensitive], [data-private], [aria-hidden="true"]') != null;
  }
  function containsSensitiveAncestor(element) {
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (isSensitiveElement(current)) return true;
      current = current.parentElement;
    }
    return false;
  }
  function safeVisibleText(element, max = 2000) {
    if (!element || containsSensitiveAncestor(element)) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.('input, textarea, select, [data-sensitive], [data-private], [aria-hidden="true"]').forEach((node) => {
      if (isSensitiveElement(node)) node.remove();
    });
    return String(clone.innerText || '').trim().slice(0, max);
  }
  function selectorForElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id && /^[A-Za-z][\w-]{0,80}$/.test(current.id)) part += `#${CSS.escape(current.id)}`;
      else {
        const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current.id) break;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }
  function describeElement(element) {
    return { selector: selectorForElement(element), tagName: element?.tagName?.toLowerCase() || 'element', text: safeVisibleText(element), sensitive: containsSensitiveAncestor(element) };
  }
  return new Promise((resolve) => {
    const onClick = (event) => { event.preventDefault(); event.stopPropagation(); document.removeEventListener('click', onClick, true); resolve(describeElement(event.target)); };
    document.addEventListener('click', onClick, true);
  });
}

export function startRecording() {
  function isSensitiveElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' && ['password', 'hidden'].includes((element.type || '').toLowerCase())) return true;
    if (['input', 'textarea', 'select'].includes(tag)) {
      const hint = [element.name, element.id, element.autocomplete, element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
      if (/(password|passwd|passcode|secret|token|api.?key|access.?key|private.?key|credit.?card|security.?code|cvv|ssn|otp|one.?time)/i.test(hint)) return true;
    }
    return element.hasAttribute('data-sensitive') || element.closest?.('[data-sensitive], [data-private], [aria-hidden="true"]') != null;
  }
  function containsSensitiveAncestor(element) {
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (isSensitiveElement(current)) return true;
      current = current.parentElement;
    }
    return false;
  }
  function selectorForElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id && /^[A-Za-z][\w-]{0,80}$/.test(current.id)) part += `#${CSS.escape(current.id)}`;
      else {
        const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current.id) break;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }
  const key = '__cloudcliCaptureRecording';
  if (window[key]) return { started: false };
  const events = [], startedAt = Date.now();
  const target = (node) => node?.nodeType === Node.ELEMENT_NODE ? selectorForElement(node) : '';
  const click = (event) => { if (events.length < 500) events.push({ type: 'click', at: Date.now() - startedAt, x: event.clientX, y: event.clientY, target: target(event.target) }); };
  const scroll = () => { if (events.length < 500) events.push({ type: 'scroll', at: Date.now() - startedAt, x: Math.round(window.scrollX), y: Math.round(window.scrollY) }); };
  const input = (event) => { if (events.length < 500 && !containsSensitiveAncestor(event.target)) events.push({ type: 'input', at: Date.now() - startedAt, target: target(event.target), valueLength: typeof event.target?.value === 'string' ? event.target.value.length : 0 }); };
  document.addEventListener('click', click, true); window.addEventListener('scroll', scroll, true); document.addEventListener('input', input, true);
  window[key] = { events, startedAt, stop() { document.removeEventListener('click', click, true); window.removeEventListener('scroll', scroll, true); document.removeEventListener('input', input, true); delete window[key]; return { events, startedAt, stoppedAt: Date.now() }; } };
  return { started: true };
}

export function stopRecording() { return window.__cloudcliCaptureRecording?.stop() || { events: [], stoppedAt: Date.now() }; }
