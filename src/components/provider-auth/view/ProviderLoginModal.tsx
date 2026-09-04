import { Info, X } from 'lucide-react';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import AntigravityRuntimePanel from '../../settings/view/tabs/agents-settings/sections/content/AntigravityRuntimePanel';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL, IS_PLATFORM } from '../../../constants/config';
import type { LLMProvider } from '../../../types/app';
type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  provider?: LLMProvider;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
  isAuthenticated?: boolean;
};

const getProviderCommand = ({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    // Prefer the dedicated auth subcommand — it writes keychain-backed OAuth
    // tokens the same way an interactive `/login` would, and exits cleanly so
    // CloudCLI can refresh status when the shell process ends.
    return 'claude auth login';
  }

  if (provider === 'cursor') {
    return 'cursor-agent login';
  }

  if (provider === 'codex') {
    return IS_PLATFORM ? 'codex login --device-auth' : 'codex login';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  if (provider === 'kilo') {
    return 'kilo auth login';
  }

  if (provider === 'grok') {
    return 'grok login';
  }

  if (provider === 'kimi') {
    return 'kimi login';
  }

  if (provider === 'qwencode') return 'qwen';

  if (provider === 'pi') {
    // Pi authenticates via the interactive /login command inside the TUI.
    return 'pi';
  }

  if (provider === 'omp') {
    // Oh My Pi authenticates via the interactive /login command inside the TUI.
    return 'omp';
  }

  return 'claude --dangerously-skip-permissions /login';
};

/**
 * Providers with no dedicated login subcommand: the CLI opens straight into
 * its interactive TUI, so the user has to know to type `/login` themselves.
 */
const getProviderLoginGuidance = (provider: LLMProvider): string | null => {
  if (provider === 'omp') {
    return 'Oh My Pi has no dedicated login command — once the terminal below is ready, type /login and follow the prompts to connect a provider.';
  }
  return null;
};

const getProviderTitle = (provider: LLMProvider) => {
  if (provider === 'claude') return 'Claude CLI Login';
  if (provider === 'cursor') return 'Cursor CLI Login';
  if (provider === 'codex') return 'Codex CLI Login';
  if (provider === 'opencode') return 'OpenCode CLI Login';
  if (provider === 'kilo') return 'Kilo Code CLI Login';
  if (provider === 'grok') return 'Grok Build CLI Login';
  if (provider === 'kimi') return 'Kimi CLI Login';
  if (provider === 'qwencode') return 'Qwen Code CLI Login';
  if (provider === 'pi') return 'Pi CLI Login';
  if (provider === 'omp') return 'Oh My Pi CLI Login';
  if (provider === 'antigravity') return 'Antigravity Setup';
  return 'Claude CLI Login';
};

export default function ProviderLoginModal({
  isOpen,
  onClose,
  provider = 'claude',
  onComplete,
  customCommand,
  isAuthenticated = false,
}: ProviderLoginModalProps) {
  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const title = getProviderTitle(provider);
  const guidance = getProviderLoginGuidance(provider);

  // Whether the login actually succeeded can't be inferred from the shell's
  // exit code alone: an interactive TUI can exit 0 on `/login` cancel, or
  // non-zero on a clean Ctrl+C after a successful login. The caller is
  // responsible for re-probing the provider's authoritative auth status
  // (e.g. via `checkProviderAuthStatus`) once this fires — this component
  // never guesses `authenticated` from the exit code itself.
  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
    // Keep the modal open so users can read terminal output before closing.
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close login modal"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {guidance && (
          <div className="flex items-start gap-2 border-b border-gray-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800 dark:border-gray-700 dark:bg-blue-900/20 dark:text-blue-200">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{guidance}</p>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {provider === 'antigravity' ? (
            // Antigravity has no login CLI to run in a terminal: it is a
            // managed download plus an ACP `authenticate` round-trip, so the
            // same setup panel Settings uses is rendered here instead of a
            // shell that would have nothing useful to type into.
            <div className="h-full overflow-y-auto p-4">
              <AntigravityRuntimePanel onStatusChange={() => onComplete?.(0)} />
            </div>
          ) : (
            <StandaloneShell project={DEFAULT_PROJECT_FOR_EMPTY_SHELL} command={command} onComplete={handleComplete} minimal={true} />
          )}
        </div>
      </div>
    </div>
  );
}
