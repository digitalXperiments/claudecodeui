import type { StudioPreviewFrame, StudioSelectedElement } from '../types';

export const STUDIO_FRAME_WIDTHS: Record<StudioPreviewFrame, number | null> = {
  mobile: 390,
  tablet: 768,
  desktop: null,
};

export const STUDIO_SELECT_MESSAGE = 'studio:element-selected';
export const STUDIO_SELECT_MODE_MESSAGE = 'studio:select-mode';

export const SELECT_BRIDGE_SOURCE = `(function () {
  var enabled = false;
  function pathOf(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + '#' + node.id);
        break;
      }
      var selector = tag;
      if (node.classList && node.classList.length) {
        selector += '.' + Array.prototype.slice.call(node.classList, 0, 3).join('.');
      }
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i += 1) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) {
          var index = same.indexOf(node) + 1;
          selector += ':nth-of-type(' + index + ')';
        }
      }
      parts.unshift(selector);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }
  function onClick(event) {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    var el = event.target;
    if (!el || !el.tagName) return;
    var classes = [];
    if (el.classList) {
      for (var i = 0; i < el.classList.length; i += 1) classes.push(el.classList[i]);
    }
    var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    parent.postMessage({
      type: '${STUDIO_SELECT_MESSAGE}',
      element: {
        tag: el.tagName.toLowerCase(),
        classes: classes,
        text: text,
        path: pathOf(el)
      }
    }, '*');
  }
  function onMessage(event) {
    var data = event.data;
    if (!data || data.type !== '${STUDIO_SELECT_MODE_MESSAGE}') return;
    enabled = !!data.enabled;
    document.documentElement.setAttribute('data-studio-select', enabled ? 'on' : 'off');
  }
  document.addEventListener('click', onClick, true);
  window.addEventListener('message', onMessage);
  var style = document.createElement('style');
  style.textContent = 'html[data-studio-select="on"] * { cursor: crosshair !important; } html[data-studio-select="on"] *:hover { outline: 2px solid #c45c26 !important; outline-offset: 2px; }';
  document.documentElement.appendChild(style);
})();`;

export function injectSelectBridge(html: string): string {
  const script = `<script>${SELECT_BRIDGE_SOURCE}</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}${script}`;
}

export function parseSelectMessage(data: unknown): StudioSelectedElement | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as { type?: unknown; element?: unknown };
  if (row.type !== STUDIO_SELECT_MESSAGE) return null;
  if (!row.element || typeof row.element !== 'object' || Array.isArray(row.element)) return null;
  const element = row.element as Record<string, unknown>;
  const tag = typeof element.tag === 'string' ? element.tag.trim() : '';
  if (!tag) return null;
  const classes = Array.isArray(element.classes)
    ? element.classes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  return {
    tag,
    classes,
    text: typeof element.text === 'string' ? element.text : undefined,
    path: typeof element.path === 'string' ? element.path : undefined,
  };
}

export function formatSelectedElement(element: StudioSelectedElement): string {
  const classSuffix = element.classes?.length ? `.${element.classes.join('.')}` : '';
  const text = element.text ? ` “${element.text.slice(0, 48)}”` : '';
  return `<${element.tag}${classSuffix}>${text}`;
}

export function selectModeMessage(enabled: boolean): { type: string; enabled: boolean } {
  return { type: STUDIO_SELECT_MODE_MESSAGE, enabled };
}
