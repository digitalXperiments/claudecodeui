/**
 * Render tests for Design Studio panes using node:test + renderToStaticMarkup.
 * Interaction/write-back coverage lives in studioWorkspaceController.test.ts
 * (SSR does not fire clicks or effects).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  injectSelectBridge,
  parseSelectMessage,
  STUDIO_SELECT_MESSAGE,
} from '../preview/selectBridge';
import type {
  StudioDesignTokens,
  StudioSelectedElement,
  StudioVariant,
  StudioVersionDetail,
} from '../types';

import StudioChatPane from './StudioChatPane';
import StudioHistoryTimeline from './StudioHistoryTimeline';
import StudioPreviewChrome from './StudioPreviewChrome';
import StudioPreviewPane from './StudioPreviewPane';
import StudioTokenPanel from './StudioTokenPanel';
import StudioVariantStrip from './StudioVariantStrip';

const TOKENS: StudioDesignTokens = {
  colors: {
    background: '#f6f4ef',
    foreground: '#161411',
    muted: '#6b655c',
    accent: '#c45c26',
    accentForeground: '#ffffff',
    card: '#ffffff',
    border: '#e6e1d6',
    wash: '#f3e4d6',
  },
  typography: {
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    headingFamily: 'ui-sans-serif, system-ui, sans-serif',
    baseSizePx: 16,
    lineHeight: 1.5,
  },
  spacing: { unitPx: 8, sectionGapPx: 28 },
  radii: { smPx: 8, mdPx: 16, lgPx: 24, pillPx: 999 },
};

function version(partial: Partial<StudioVersionDetail> & Pick<StudioVersionDetail, 'id' | 'kind' | 'message'>): StudioVersionDetail {
  return {
    parentVersionId: null,
    selectedElement: null,
    createdAt: '2026-08-22T12:00:00.000Z',
    variantIds: [],
    html: '<html><body>preview</body></html>',
    notes: 'notes',
    handoff: 'handoff',
    ...partial,
  };
}

test('chat pane renders consecutive turns, composer submit, and generation progress', () => {
  const html = renderToStaticMarkup(
    React.createElement(StudioChatPane, {
      versions: [
        version({ id: 'ver_1', kind: 'initial', message: 'Coffee loyalty app', createdAt: '2026-08-22T12:00:00.000Z' }),
        version({ id: 'ver_2', kind: 'turn', message: 'Make the hero darker', createdAt: '2026-08-22T12:01:00.000Z' }),
        version({ id: 'ver_3', kind: 'turn', message: 'Enlarge the primary CTA', createdAt: '2026-08-22T12:02:00.000Z' }),
      ],
      status: 'generating',
      generation: {
        kind: 'turn',
        startedAt: '2026-08-22T12:03:00.000Z',
        message: 'Add a rewards ticker',
        error: null,
      },
      draft: 'Add a rewards ticker',
      selection: { tag: 'button', classes: ['primary'], text: 'Join now', path: 'header > button.primary' },
      busy: false,
      onDraftChange: () => undefined,
      onSubmit: () => undefined,
      onRequestVariants: () => undefined,
      onClearSelection: () => undefined,
    }),
  );

  assert.ok(html.includes('Coffee loyalty app'));
  assert.ok(html.includes('Make the hero darker'));
  assert.ok(html.includes('Enlarge the primary CTA'));
  assert.ok(html.includes('Add a rewards ticker'));
  assert.ok(html.includes('Refining prototype'));
  assert.ok(html.includes('Targeting'));
  assert.ok(html.includes('button.primary'));
  assert.ok(html.includes('Send'));
  assert.ok(html.includes('Request variants'));
  assert.ok(html.includes('type="submit"'));
  assert.ok(html.includes('data-studio-pane="chat"'));
});

test('variant strip renders side-by-side variants with use-this-one', () => {
  const variants: StudioVariant[] = [
    {
      id: 'var_warm',
      versionId: 'ver_2',
      label: 'Warm editorial',
      direction: 'Cream paper, serif headlines',
      html: '<html><body>warm</body></html>',
      notes: '',
      handoff: '',
      createdAt: '2026-08-22T12:04:00.000Z',
    },
    {
      id: 'var_dense',
      versionId: 'ver_2',
      label: 'Dense dashboard',
      direction: 'Tight grid, tabular data',
      html: '<html><body>dense</body></html>',
      notes: '',
      handoff: '',
      createdAt: '2026-08-22T12:04:01.000Z',
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(StudioVariantStrip, {
      variants,
      onPromote: () => undefined,
    }),
  );
  assert.ok(html.includes('Warm editorial'));
  assert.ok(html.includes('Dense dashboard'));
  assert.match(html, /Use this one[\s\S]*Use this one/);
  assert.ok(html.includes('data-studio-pane="variants"'));
});

test('history timeline lists turns and promotions and offers revert', () => {
  const html = renderToStaticMarkup(
    React.createElement(StudioHistoryTimeline, {
      versions: [
        version({ id: 'ver_1', kind: 'initial', message: 'Brief', createdAt: '2026-08-22T12:00:00.000Z' }),
        version({ id: 'ver_2', kind: 'turn', message: 'Add a ponds table', createdAt: '2026-08-22T12:01:00.000Z' }),
        version({
          id: 'ver_3',
          kind: 'variant-promotion',
          message: 'Promoted variant: Warm editorial',
          createdAt: '2026-08-22T12:02:00.000Z',
          promotedFromVariantId: 'var_warm',
        }),
      ],
      activeVersionId: 'ver_3',
      onRevert: () => undefined,
    }),
  );
  assert.ok(html.includes('Add a ponds table'));
  assert.ok(html.includes('Promoted variant: Warm editorial'));
  assert.ok(html.includes('Promotion'));
  assert.ok(html.includes('Revert to here'));
  assert.ok(html.includes('Active'));
  assert.ok(html.includes('data-studio-pane="history"'));
});

test('token panel exposes colors, typography, spacing, radii, and apply', () => {
  const html = renderToStaticMarkup(
    React.createElement(StudioTokenPanel, {
      tokens: TOKENS,
      onApply: () => undefined,
    }),
  );
  assert.ok(html.includes('Design tokens'));
  assert.ok(html.includes('Background'));
  assert.ok(html.includes('Accent'));
  assert.ok(html.includes('Body font'));
  assert.ok(html.includes('Heading font'));
  assert.ok(html.includes('Base size (px)'));
  assert.ok(html.includes('Unit (px)'));
  assert.ok(html.includes('Section gap (px)'));
  assert.ok(html.includes('Pill (px)'));
  assert.ok(html.includes('Apply tokens'));
  assert.ok(html.includes('#c45c26'));
  assert.ok(html.includes('data-studio-pane="tokens"'));
});

test('preview chrome offers mobile, tablet, desktop frames and select mode', () => {
  const html = renderToStaticMarkup(
    <StudioPreviewChrome
      title="PondPilot"
      frame="tablet"
      selectMode
      onFrameChange={() => undefined}
      onSelectModeChange={() => undefined}
    >
      <div>preview</div>
    </StudioPreviewChrome>,
  );
  assert.ok(html.includes('Mobile'));
  assert.ok(html.includes('Tablet'));
  assert.ok(html.includes('Desktop'));
  assert.ok(html.includes('Selecting…'));
  assert.ok(html.includes('Click any element in the preview'));
});

test('preview pane sandboxes html inside a device frame', () => {
  const html = renderToStaticMarkup(
    React.createElement(StudioPreviewPane, {
      title: 'PondPilot',
      html: '<html><body><button class="primary">Join</button></body></html>',
      frame: 'mobile',
      selectMode: true,
      onSelectElement: () => undefined,
    }),
  );
  assert.ok(html.includes('data-frame="mobile"'));
  assert.ok(html.includes('390px'));
  assert.ok(html.includes('sandbox="allow-scripts allow-forms allow-modals"'));
  assert.ok(html.includes('studio:element-selected'));
});

test('select bridge injects click capture and parses the posted element', () => {
  const injected = injectSelectBridge('<html><body><h1>Hi</h1></body></html>');
  assert.ok(injected.includes('studio:element-selected'));
  assert.ok(injected.includes('</body>'));

  const element = parseSelectMessage({
    type: STUDIO_SELECT_MESSAGE,
    element: {
      tag: 'button',
      classes: ['primary'],
      text: 'See how it works',
      path: 'header > nav > button.primary',
    },
  });
  assert.deepEqual(element, {
    tag: 'button',
    classes: ['primary'],
    text: 'See how it works',
    path: 'header > nav > button.primary',
  } satisfies StudioSelectedElement);
  assert.equal(parseSelectMessage({ type: 'other' }), null);
});
