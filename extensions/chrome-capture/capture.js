// Pure, page-safe helpers injected by sidepanel.js through chrome.scripting.
export function selectorForElement(element) {
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

export function describeElement(element) {
  return {
    selector: selectorForElement(element),
    tagName: element?.tagName?.toLowerCase() || 'element',
    text: String(element?.innerText || '').trim().slice(0, 2000),
  };
}

export function captureSelectedText() {
  const selection = window.getSelection();
  return { text: String(selection || '').trim().slice(0, 20000), source: location.href };
}

export async function selectElementOnPage() {
  const describe = (element) => ({ tagName: element?.tagName?.toLowerCase() || 'element', text: String(element?.innerText || '').trim().slice(0, 2000), selector: (() => { const parts = []; let current = element; while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) { let part = current.tagName.toLowerCase(); if (current.id && /^[A-Za-z][\w-]{0,80}$/.test(current.id)) part += `#${CSS.escape(current.id)}`; else { const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : []; if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`; } parts.unshift(part); if (current.id) break; current = current.parentElement; } return parts.join(' > '); })() });
  return new Promise((resolve) => {
    const onClick = (event) => {
      event.preventDefault(); event.stopPropagation();
      document.removeEventListener('click', onClick, true);
      resolve(describe(event.target));
    };
    document.addEventListener('click', onClick, true);
  });
}

export function startRecording() {
  const key = '__cloudcliCaptureRecording';
  if (window[key]) return { started: false };
  const events = [];
  const startedAt = Date.now();
  const target = (node) => { if (!node?.nodeType || node.nodeType !== Node.ELEMENT_NODE) return ''; const parts = []; let current = node; while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) { let part = current.tagName.toLowerCase(); if (current.id && /^[A-Za-z][\w-]{0,80}$/.test(current.id)) part += `#${CSS.escape(current.id)}`; parts.unshift(part); if (current.id) break; current = current.parentElement; } return parts.join(' > '); };
  const click = (event) => { if (events.length < 500) events.push({ type: 'click', at: Date.now() - startedAt, x: event.clientX, y: event.clientY, target: target(event.target) }); };
  const scroll = () => { if (events.length < 500) events.push({ type: 'scroll', at: Date.now() - startedAt, x: Math.round(window.scrollX), y: Math.round(window.scrollY) }); };
  const input = (event) => { if (events.length < 500) events.push({ type: 'input', at: Date.now() - startedAt, target: target(event.target), valueLength: typeof event.target?.value === 'string' ? event.target.value.length : 0 }); };
  document.addEventListener('click', click, true); window.addEventListener('scroll', scroll, true); document.addEventListener('input', input, true);
  window[key] = { events, startedAt, stop() { document.removeEventListener('click', click, true); window.removeEventListener('scroll', scroll, true); document.removeEventListener('input', input, true); delete window[key]; return { events, startedAt, stoppedAt: Date.now() }; } };
  return { started: true };
}

export function stopRecording() { return window.__cloudcliCaptureRecording?.stop() || { events: [], stoppedAt: Date.now() }; }
