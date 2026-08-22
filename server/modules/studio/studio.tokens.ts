import type { StudioDesignTokens, StudioTokensPatch } from '@/modules/studio/studio.types.js';
import { AppError } from '@/shared/utils.js';

export type StudioPalette = {
  bg: string;
  ink: string;
  muted: string;
  card: string;
  line: string;
  accent: string;
  accentInk: string;
  wash: string;
};

const DEFAULT_PALETTE: StudioPalette = {
  bg: '#f6f4ef',
  ink: '#161411',
  muted: '#6b655c',
  card: '#ffffff',
  line: '#e6e1d6',
  accent: '#c45c26',
  accentInk: '#fff',
  wash: '#f3e4d6',
};

export function paletteForBrief(brief: string): StudioPalette {
  const text = brief.toLowerCase();
  if (/(farm|agri|prawn|shrimp|iot|sensor|aqua|ocean|monitor)/.test(text)) {
    return {
      bg: '#eef6f4',
      ink: '#10231f',
      muted: '#4d6a64',
      card: '#ffffff',
      line: '#cfe3dd',
      accent: '#0f766e',
      accentInk: '#ffffff',
      wash: '#d7efe9',
    };
  }
  if (/(coffee|cafe|roast|bean)/.test(text)) {
    return {
      bg: '#f6f1ea',
      ink: '#2a1b12',
      muted: '#7a6354',
      card: '#fffaf4',
      line: '#ead9c8',
      accent: '#8b4513',
      accentInk: '#fff',
      wash: '#f0e0cf',
    };
  }
  if (/(health|clinic|care|wellness|hospital)/.test(text)) {
    return {
      bg: '#f3f7fb',
      ink: '#132033',
      muted: '#5b6b7c',
      card: '#ffffff',
      line: '#d5e0ea',
      accent: '#2563eb',
      accentInk: '#fff',
      wash: '#dbeafe',
    };
  }
  if (/(finance|bank|pay|invoice|billing)/.test(text)) {
    return {
      bg: '#f4f6f4',
      ink: '#14201a',
      muted: '#5b6b62',
      card: '#ffffff',
      line: '#d7ddd8',
      accent: '#166534',
      accentInk: '#fff',
      wash: '#dcfce7',
    };
  }
  return { ...DEFAULT_PALETTE };
}

export function tokensFromPalette(palette: StudioPalette): StudioDesignTokens {
  return {
    colors: {
      background: palette.bg,
      foreground: palette.ink,
      muted: palette.muted,
      accent: palette.accent,
      accentForeground: palette.accentInk,
      card: palette.card,
      border: palette.line,
      wash: palette.wash,
    },
    typography: {
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      headingFamily: 'ui-sans-serif, system-ui, sans-serif',
      baseSizePx: 16,
      lineHeight: 1.5,
    },
    spacing: {
      unitPx: 8,
      sectionGapPx: 28,
    },
    radii: {
      smPx: 8,
      mdPx: 16,
      lgPx: 24,
      pillPx: 999,
    },
  };
}

export const DEFAULT_STUDIO_TOKENS: StudioDesignTokens = tokensFromPalette(DEFAULT_PALETTE);

export function defaultTokensForBrief(brief: string): StudioDesignTokens {
  return tokensFromPalette(paletteForBrief(brief));
}

export function paletteFromTokens(tokens: StudioDesignTokens): StudioPalette {
  return {
    bg: tokens.colors.background,
    ink: tokens.colors.foreground,
    muted: tokens.colors.muted,
    card: tokens.colors.card,
    line: tokens.colors.border,
    accent: tokens.colors.accent,
    accentInk: tokens.colors.accentForeground,
    wash: tokens.colors.wash,
  };
}

function asColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim();
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function mergeColorTokens(
  base: StudioDesignTokens['colors'],
  patch: unknown,
): StudioDesignTokens['colors'] {
  const row = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  return {
    background: asColor(row.background, base.background),
    foreground: asColor(row.foreground, base.foreground),
    muted: asColor(row.muted, base.muted),
    accent: asColor(row.accent, base.accent),
    accentForeground: asColor(row.accentForeground, base.accentForeground),
    card: asColor(row.card, base.card),
    border: asColor(row.border, base.border),
    wash: asColor(row.wash, base.wash),
  };
}

function mergeTypography(
  base: StudioDesignTokens['typography'],
  patch: unknown,
): StudioDesignTokens['typography'] {
  const row = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  return {
    fontFamily: asColor(row.fontFamily, base.fontFamily),
    headingFamily: asColor(row.headingFamily, base.headingFamily),
    baseSizePx: asNumber(row.baseSizePx, base.baseSizePx),
    lineHeight: asNumber(row.lineHeight, base.lineHeight),
  };
}

function mergeSpacing(
  base: StudioDesignTokens['spacing'],
  patch: unknown,
): StudioDesignTokens['spacing'] {
  const row = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  return {
    unitPx: asNumber(row.unitPx, base.unitPx),
    sectionGapPx: asNumber(row.sectionGapPx, base.sectionGapPx),
  };
}

function mergeRadii(
  base: StudioDesignTokens['radii'],
  patch: unknown,
): StudioDesignTokens['radii'] {
  const row = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  return {
    smPx: asNumber(row.smPx, base.smPx),
    mdPx: asNumber(row.mdPx, base.mdPx),
    lgPx: asNumber(row.lgPx, base.lgPx),
    pillPx: asNumber(row.pillPx, base.pillPx),
  };
}

export function mergeStudioTokens(
  base: StudioDesignTokens,
  patch: StudioTokensPatch | undefined,
): StudioDesignTokens {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return structuredClone(base);
  }
  return {
    colors: mergeColorTokens(base.colors, patch.colors),
    typography: mergeTypography(base.typography, patch.typography),
    spacing: mergeSpacing(base.spacing, patch.spacing),
    radii: mergeRadii(base.radii, patch.radii),
  };
}

export function parseStudioTokens(raw: unknown, fallback: StudioDesignTokens): StudioDesignTokens {
  if (raw == null) return structuredClone(fallback);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Design tokens must be an object', {
      code: 'STUDIO_TOKENS_INVALID',
      statusCode: 400,
    });
  }
  return mergeStudioTokens(fallback, raw as StudioTokensPatch);
}
