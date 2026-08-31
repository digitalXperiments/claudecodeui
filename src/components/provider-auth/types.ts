import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  /**
   * Whether the provider's CLI/runtime is installed. `null` means the backend
   * didn't report installation state for this provider (older providers don't
   * distinguish "not installed" from "not authenticated") — callers should
   * treat `null` as "unknown / assume installed" rather than as a hard no.
   */
  installed: boolean | null;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi', 'omp'];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  opencode: '/api/providers/opencode/auth/status',
  kilo: '/api/providers/kilo/auth/status',
  cline: '/api/providers/cline/auth/status',
  grok: '/api/providers/grok/auth/status',
  kimi: '/api/providers/kimi/auth/status',
  qwencode: '/api/providers/qwencode/auth/status',
  pi: '/api/providers/pi/auth/status',
  omp: '/api/providers/omp/auth/status',
};

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  cursor: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  codex: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  opencode: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  kilo: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  cline: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  grok: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  kimi: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  qwencode: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  pi: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
  omp: { installed: null, authenticated: false, email: null, method: null, error: null, loading },
});
