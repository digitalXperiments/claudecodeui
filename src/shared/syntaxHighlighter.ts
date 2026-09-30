import { createElement, useEffect, useState } from 'react';
import type { ComponentType, CSSProperties, HTMLAttributes, ReactNode } from 'react';

// The two themes the app renders with. The per-theme CJS files carry the same
// generated objects as the dist/esm styles barrel these components previously
// imported; deep per-theme paths also keep the other ~40 themes out of the
// bundle. `unwrapDefault` bridges the interop difference between Vite (gives
// the transpiled default directly) and Node (gives the whole module.exports).
// They are plain objects (a few KB), so they stay eager and the fallback below
// can paint the final box geometry and base colours before Prism arrives.
import oneDarkModule from 'react-syntax-highlighter/dist/cjs/styles/prism/one-dark';
import oneLightModule from 'react-syntax-highlighter/dist/cjs/styles/prism/one-light';

const unwrapDefault = (mod: any) => (mod && mod.default ? mod.default : mod);

export const oneDark = unwrapDefault(oneDarkModule);
export const oneLight = unwrapDefault(oneLightModule);

type PrismStyle = Record<string, CSSProperties>;

export type SyntaxHighlighterProps = {
  language?: string;
  style?: PrismStyle;
  customStyle?: CSSProperties;
  codeTagProps?: HTMLAttributes<HTMLElement>;
  children?: ReactNode;
  [prop: string]: any;
};

/*
 * Prism (react-syntax-highlighter + refractor + ~50 grammars, ~160 KB) lives in
 * syntaxHighlighterCore.ts and is loaded off the startup path: prefetched when
 * the browser is idle after boot, or immediately when the first code block
 * mounts. Until it resolves, code renders in the same <pre>/<code> box with the
 * theme's base colours, so the swap only adds token colours (no layout shift).
 */
let LoadedHighlighter: ComponentType<any> | null = null;
let highlighterPromise: Promise<ComponentType<any>> | null = null;

export const loadSyntaxHighlighter = (): Promise<ComponentType<any>> => {
  if (!highlighterPromise) {
    highlighterPromise = import('./syntaxHighlighterCore').then((module) => {
      LoadedHighlighter = module.PrismSyntaxHighlighter;
      return module.PrismSyntaxHighlighter;
    });
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const prefetch = () => {
    loadSyntaxHighlighter().catch(() => {});
  };
  const schedule = () => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(prefetch, { timeout: 5000 });
    } else {
      setTimeout(prefetch, 2000);
    }
  };
  if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule, { once: true });
  }
}

function PlainCodeFallback({ language, style = {}, customStyle = {}, codeTagProps, children }: SyntaxHighlighterProps) {
  const preStyle = Object.assign({}, style['pre[class*="language-"]'], customStyle);
  const codeProps = codeTagProps
    ? { ...codeTagProps, style: { whiteSpace: 'pre', ...codeTagProps.style } as CSSProperties }
    : {
        className: language ? `language-${language}` : undefined,
        style: {
          whiteSpace: 'pre',
          ...style['code[class*="language-"]'],
          ...style[`code[class*="language-${language}"]`],
        } as CSSProperties,
      };
  return createElement('pre', { style: preStyle }, createElement('code', codeProps, children));
}

/**
 * The syntax highlighter every code block in the app renders through — chat
 * markdown (Markdown.tsx) and mission-control article drafts
 * (ArticleDraftCard.tsx). API-compatible with react-syntax-highlighter's
 * PrismLight for the props those callers use.
 */
export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
  const [Highlighter, setHighlighter] = useState(() => LoadedHighlighter);

  useEffect(() => {
    if (Highlighter) {
      return;
    }
    let cancelled = false;
    loadSyntaxHighlighter().then(
      (loaded) => {
        if (!cancelled) setHighlighter(() => loaded);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [Highlighter]);

  return createElement(Highlighter ?? PlainCodeFallback, props);
}
