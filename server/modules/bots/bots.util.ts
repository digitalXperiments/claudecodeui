/** Shared helpers for the bots repositories: timestamps and safe JSON handling. */

export const nowIso = (): string => new Date().toISOString();

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseStringArray(raw: string | null | undefined): string[] {
  return parseJsonArray(raw).filter((value): value is string => typeof value === 'string');
}

export const toJson = (value: unknown, fallback: '{}' | '[]' = '{}'): string =>
  JSON.stringify(value ?? JSON.parse(fallback));

export const toFlag = (value: boolean | undefined, fallback: boolean): number =>
  (value ?? fallback) ? 1 : 0;
