/**
 * Client-facing Design Studio payload types.
 *
 * Source of truth for the versioned prototype API. The UI client should keep
 * `src/components/studio/types.ts` in sync with this file.
 */

export const STUDIO_FORMAT = 'cloudcli.studio.v2';

export type StudioPrototypeStatus = 'draft' | 'generating' | 'ready' | 'failed';

export type StudioVersionKind = 'initial' | 'turn' | 'variant-promotion' | 'revert';

export type StudioGenerationKind = 'turn' | 'variants' | 'tokens' | 'swarm';

export type StudioSelectedElement = {
  tag: string;
  classes?: string[];
  text?: string;
  path?: string;
};

export type StudioDesignTokens = {
  colors: {
    background: string;
    foreground: string;
    muted: string;
    accent: string;
    accentForeground: string;
    card: string;
    border: string;
    wash: string;
  };
  typography: {
    fontFamily: string;
    headingFamily: string;
    baseSizePx: number;
    lineHeight: number;
  };
  spacing: {
    unitPx: number;
    sectionGapPx: number;
  };
  radii: {
    smPx: number;
    mdPx: number;
    lgPx: number;
    pillPx: number;
  };
};

export type StudioGenerationProgress = {
  kind: StudioGenerationKind;
  startedAt: string;
  message: string | null;
  error: string | null;
  variantCount?: number;
};

export type StudioPrototype = {
  format: typeof STUDIO_FORMAT;
  id: string;
  projectId: string;
  title: string;
  brief: string;
  skills: string[];
  status: StudioPrototypeStatus;
  relativeDir: string;
  htmlRelativePath: string;
  notesRelativePath: string;
  handoffRelativePath: string;
  swarmId: string | null;
  activeVersionId: string;
  generation: StudioGenerationProgress | null;
  createdAt: string;
  updatedAt: string;
};

export type StudioVersion = {
  id: string;
  parentVersionId: string | null;
  kind: StudioVersionKind;
  message: string;
  selectedElement: StudioSelectedElement | null;
  createdAt: string;
  variantIds: string[];
  promotedFromVariantId?: string | null;
  revertedFromVersionId?: string | null;
};

export type StudioVersionDetail = StudioVersion & {
  html: string;
  notes: string;
  handoff: string;
};

export type StudioVariant = {
  id: string;
  versionId: string;
  label: string;
  direction: string;
  html: string;
  notes: string;
  handoff: string;
  createdAt: string;
};

export type StudioPrototypeDetail = StudioPrototype & {
  html: string;
  notes: string;
  handoff: string;
  tokens: StudioDesignTokens;
  versions: StudioVersionDetail[];
  activeVersion: StudioVersionDetail;
  variants: StudioVariant[];
};

export type StudioTokensPatch = {
  colors?: Partial<StudioDesignTokens['colors']>;
  typography?: Partial<StudioDesignTokens['typography']>;
  spacing?: Partial<StudioDesignTokens['spacing']>;
  radii?: Partial<StudioDesignTokens['radii']>;
};

export type CreateStudioPrototypeInput = {
  projectId: string;
  title?: string;
  brief: string;
  skills?: string[];
  tokens?: StudioTokensPatch;
};

export type UpdateStudioPrototypeInput = {
  title?: string;
  brief?: string;
  skills?: string[];
  html?: string;
  notes?: string;
  handoff?: string;
  status?: StudioPrototypeStatus;
  swarmId?: string | null;
  generation?: StudioGenerationProgress | null;
  activeVersionId?: string;
};

export type AppendStudioTurnInput = {
  message: string;
  selectedElement?: StudioSelectedElement | null;
};

export type GenerateStudioVariantsInput = {
  message?: string;
  count?: number;
  selectedElement?: StudioSelectedElement | null;
};

export type UpdateStudioTokensInput = {
  tokens: StudioTokensPatch;
  regenerate?: boolean;
};

export type LaunchStudioSwarmInput = {
  projectId: string;
  prototypeId: string;
};

export type StudioGenerateRequest = {
  projectPath: string;
  brief: string;
  title: string;
  message: string;
  history: Array<{ kind: StudioVersionKind; message: string }>;
  tokens: StudioDesignTokens;
  parentHtml: string;
  parentNotes: string;
  parentHandoff: string;
  selectedElement?: StudioSelectedElement | null;
  variantDirection?: { label: string; direction: string } | null;
  skills: string[];
};

export type StudioGenerateResult = {
  html: string;
  notes: string;
  handoff: string;
};

export type StudioGenerateFn = (input: StudioGenerateRequest) => Promise<StudioGenerateResult>;
