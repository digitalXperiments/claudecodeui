import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  StudioDesignTokens,
  StudioPrototypeDetail,
  StudioSelectedElement,
  StudioVariant,
  StudioVersionDetail,
} from '../types';

import {
  createStudioWorkspaceController,
  type StudioWorkspaceState,
} from './studioWorkspaceController';

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

function version(
  partial: Partial<StudioVersionDetail> & Pick<StudioVersionDetail, 'id' | 'kind' | 'message'>,
): StudioVersionDetail {
  return {
    parentVersionId: null,
    selectedElement: null,
    createdAt: '2026-08-22T12:00:00.000Z',
    variantIds: [],
    html: `<html><body>${partial.message}</body></html>`,
    notes: `Notes: ${partial.message}`,
    handoff: `Handoff: ${partial.message}`,
    ...partial,
  };
}

function detail(overrides: Partial<StudioPrototypeDetail> = {}): StudioPrototypeDetail {
  const initial = version({ id: 'ver_initial', kind: 'initial', message: 'Coffee loyalty' });
  const versions = overrides.versions ?? [initial];
  const activeVersion = overrides.activeVersion ?? versions[versions.length - 1];
  return {
    format: 'cloudcli.studio.v2',
    id: 'proto_1',
    projectId: 'proj_1',
    title: 'Coffee loyalty',
    brief: 'Coffee loyalty',
    skills: [],
    status: 'ready',
    relativeDir: '.cloudcli/studio/proto_1',
    htmlRelativePath: 'prototype.html',
    notesRelativePath: 'notes.md',
    handoffRelativePath: 'handoff.md',
    swarmId: null,
    activeVersionId: activeVersion.id,
    generation: null,
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:00:00.000Z',
    html: activeVersion.html,
    notes: activeVersion.notes,
    handoff: activeVersion.handoff,
    tokens: TOKENS,
    versions,
    activeVersion,
    variants: [],
    ...overrides,
  };
}

type ApiCalls = {
  appendTurn: Array<{ message: string; selectedElement?: StudioSelectedElement | null }>;
  generateVariants: unknown[];
  promoteVariant: string[];
  revertToVersion: string[];
  updateTokens: Array<{ tokens: unknown; regenerate?: boolean }>;
  get: number;
};

function mount(seed: StudioPrototypeDetail = detail()) {
  const states: StudioWorkspaceState[] = [];
  const calls: ApiCalls = {
    appendTurn: [],
    generateVariants: [],
    promoteVariant: [],
    revertToVersion: [],
    updateTokens: [],
    get: 0,
  };
  let current = seed;
  const ticks: Array<() => void> = [];

  const api = {
    list: async () => [current],
    get: async () => {
      calls.get += 1;
      return current;
    },
    create: async () => current,
    remove: async () => undefined,
    appendTurn: async (_projectId: string, _id: string, input: { message: string; selectedElement?: StudioSelectedElement | null }) => {
      calls.appendTurn.push(input);
      const nextVersion = version({
        id: `ver_turn_${calls.appendTurn.length}`,
        kind: 'turn',
        message: input.message,
        parentVersionId: current.activeVersionId,
        selectedElement: input.selectedElement ?? null,
        html: `<html><body><!-- edit:${input.message} -->${current.html}</body></html>`,
      });
      current = detail({
        ...current,
        status: 'generating',
        generation: {
          kind: 'turn',
          startedAt: '2026-08-22T12:05:00.000Z',
          message: input.message,
          error: null,
        },
        versions: [...current.versions, nextVersion],
        activeVersion: nextVersion,
        activeVersionId: nextVersion.id,
        html: nextVersion.html,
        notes: nextVersion.notes,
        handoff: nextVersion.handoff,
      });
      return current;
    },
    generateVariants: async () => {
      calls.generateVariants.push(true);
      const variants: StudioVariant[] = [
        {
          id: 'var_1',
          versionId: current.activeVersionId,
          label: 'Warm editorial',
          direction: 'Cream paper',
          html: '<html><body data-variant="Warm editorial"></body></html>',
          notes: '',
          handoff: '',
          createdAt: '2026-08-22T12:06:00.000Z',
        },
        {
          id: 'var_2',
          versionId: current.activeVersionId,
          label: 'Dense dashboard',
          direction: 'Tight grid',
          html: '<html><body data-variant="Dense dashboard"></body></html>',
          notes: '',
          handoff: '',
          createdAt: '2026-08-22T12:06:01.000Z',
        },
      ];
      current = detail({
        ...current,
        status: 'generating',
        generation: {
          kind: 'variants',
          startedAt: '2026-08-22T12:06:00.000Z',
          message: current.activeVersion.message,
          error: null,
          variantCount: 2,
        },
        variants,
      });
      return current;
    },
    promoteVariant: async (_projectId: string, _id: string, variantId: string) => {
      calls.promoteVariant.push(variantId);
      const picked = current.variants.find((variant) => variant.id === variantId);
      const promoted = version({
        id: 'ver_promoted',
        kind: 'variant-promotion',
        message: `Promoted variant: ${picked?.label ?? variantId}`,
        parentVersionId: current.activeVersionId,
        promotedFromVariantId: variantId,
        html: picked?.html ?? current.html,
      });
      current = detail({
        ...current,
        status: 'ready',
        generation: null,
        versions: [...current.versions, promoted],
        activeVersion: promoted,
        activeVersionId: promoted.id,
        html: promoted.html,
        variants: [],
      });
      return current;
    },
    revertToVersion: async (_projectId: string, _id: string, versionId: string) => {
      calls.revertToVersion.push(versionId);
      const target = current.versions.find((entry) => entry.id === versionId) ?? current.activeVersion;
      const reverted = version({
        id: 'ver_revert',
        kind: 'revert',
        message: `Reverted to ${target.id}`,
        parentVersionId: target.id,
        revertedFromVersionId: target.id,
        html: target.html,
      });
      current = detail({
        ...current,
        status: 'ready',
        generation: null,
        versions: [...current.versions, reverted],
        activeVersion: reverted,
        activeVersionId: reverted.id,
        html: reverted.html,
      });
      return current;
    },
    updateTokens: async (_projectId: string, _id: string, input: { tokens: { colors?: { accent?: string } }; regenerate?: boolean }) => {
      calls.updateTokens.push(input);
      const accent = input.tokens.colors?.accent ?? current.tokens.colors.accent;
      const tokens = {
        ...current.tokens,
        colors: { ...current.tokens.colors, accent },
      };
      const regen = version({
        id: 'ver_tokens',
        kind: 'turn',
        message: 'Apply updated design tokens',
        parentVersionId: current.activeVersionId,
        html: `<html><body data-accent="${accent}"></body></html>`,
      });
      current = detail({
        ...current,
        status: input.regenerate === false ? 'ready' : 'generating',
        generation: input.regenerate === false ? null : {
          kind: 'turn',
          startedAt: '2026-08-22T12:07:00.000Z',
          message: 'Apply updated design tokens',
          error: null,
        },
        tokens,
        versions: input.regenerate === false ? current.versions : [...current.versions, regen],
        activeVersion: input.regenerate === false ? current.activeVersion : regen,
        activeVersionId: input.regenerate === false ? current.activeVersionId : regen.id,
        html: input.regenerate === false ? current.html : regen.html,
      });
      return current;
    },
    launchSwarm: async () => ({ swarmId: 'swarm_1', prototype: current }),
    ideatePrompt: async () => ({ prompt: 'ideate', prototype: current }),
  };

  const controller = createStudioWorkspaceController({
    api,
    onState: (state) => {
      states.push(state);
    },
    initialProjectId: 'proj_1',
    setIntervalFn: ((fn: () => void) => {
      ticks.push(fn);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  return {
    controller,
    states,
    calls,
    ticks,
    finishGeneration: () => {
      current = { ...current, status: 'ready', generation: null };
    },
  };
}

test('submitTurn appends a refinement and polls until the new version is ready', async () => {
  const { controller, calls, ticks, finishGeneration } = mount();
  await controller.selectPrototype({ projectId: 'proj_1', id: 'proto_1' });
  controller.setDraft('Make the hero darker');
  controller.setPendingSelection({
    tag: 'h1',
    path: 'body > h1',
    text: 'Punch card',
  });

  await controller.submitTurn();
  assert.equal(calls.appendTurn.length, 1);
  assert.equal(calls.appendTurn[0]?.message, 'Make the hero darker');
  assert.equal(calls.appendTurn[0]?.selectedElement?.tag, 'h1');
  assert.equal(controller.getState().draft, '');
  assert.equal(controller.getState().pendingSelection, null);
  assert.equal(controller.getState().active?.status, 'generating');
  assert.equal(controller.getState().active?.generation?.kind, 'turn');
  assert.ok(ticks.length >= 1);

  finishGeneration();
  await ticks[0]?.();
  assert.equal(controller.getState().active?.status, 'ready');
  assert.match(controller.getState().active?.html ?? '', /Make the hero darker/);

  controller.setDraft('Enlarge the primary CTA');
  await controller.submitTurn();
  controller.setDraft('Add a rewards ticker');
  await controller.submitTurn();
  assert.equal(calls.appendTurn.length, 3);
  assert.equal(controller.getState().active?.versions.length, 4);
});

test('promoteVariant makes the picked variant the active version', async () => {
  const { controller, calls } = mount();
  await controller.selectPrototype({ projectId: 'proj_1', id: 'proto_1' });
  await controller.requestVariants(2);
  assert.equal(calls.generateVariants.length, 1);
  assert.equal(controller.getState().active?.variants.length, 2);

  await controller.promoteVariant('var_2');
  assert.deepEqual(calls.promoteVariant, ['var_2']);
  const active = controller.getState().active;
  assert.equal(active?.activeVersion.kind, 'variant-promotion');
  assert.match(active?.html ?? '', /Dense dashboard/);
  assert.equal(active?.activeVersion.promotedFromVariantId, 'var_2');
});

test('revertToVersion restores that preview as the new parent', async () => {
  const { controller, calls } = mount();
  await controller.selectPrototype({ projectId: 'proj_1', id: 'proto_1' });
  controller.setDraft('Add a sidebar');
  await controller.submitTurn();
  const initialId = 'ver_initial';

  await controller.revertToVersion(initialId);
  assert.deepEqual(calls.revertToVersion, [initialId]);
  const active = controller.getState().active;
  assert.equal(active?.activeVersion.kind, 'revert');
  assert.equal(active?.html, '<html><body>Coffee loyalty</body></html>');
  assert.equal(active?.activeVersion.revertedFromVersionId, initialId);
});

test('applyTokens writes back with regenerate and updates persisted tokens', async () => {
  const { controller, calls, ticks, finishGeneration } = mount();
  await controller.selectPrototype({ projectId: 'proj_1', id: 'proto_1' });
  await controller.applyTokens({ colors: { accent: '#112233' } });
  assert.equal(calls.updateTokens.length, 1);
  assert.equal(calls.updateTokens[0]?.regenerate, true);
  assert.equal(controller.getState().active?.tokens.colors.accent, '#112233');
  assert.equal(controller.getState().active?.status, 'generating');

  finishGeneration();
  await ticks[0]?.();
  assert.equal(controller.getState().active?.tokens.colors.accent, '#112233');
  assert.match(controller.getState().active?.html ?? '', /#112233/);
});
