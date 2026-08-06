import { useTranslation } from 'react-i18next';

import { Input } from '../../../shared/view/ui';
import { shouldShowGithubAuthentication } from '../utils/pathUtils';
import type { GithubTokenCredential, TokenMode } from '../types';

import GithubAuthenticationCard from './GithubAuthenticationCard';
import WorkspacePathField from './WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  githubUrl: string;
  enableMemory: boolean;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onEnableMemoryChange: (enableMemory: boolean) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
  onAdvanceToConfirm: () => void;
};

export default function StepConfiguration({
  workspacePath,
  githubUrl,
  enableMemory,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  onWorkspacePathChange,
  onGithubUrlChange,
  onEnableMemoryChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const showGithubAuth = shouldShowGithubAuthentication(githubUrl);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.githubUrl')}
        </label>
        <Input
          type="text"
          value={githubUrl}
          onChange={(event) => onGithubUrlChange(event.target.value)}
          placeholder="https://github.com/username/repository"
          className="w-full"
          disabled={isCreating}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.githubHelp')}
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40">
        <label
          htmlFor="project-wizard-enable-memory"
          className="flex cursor-pointer items-start gap-3"
        >
          <input
            id="project-wizard-enable-memory"
            type="checkbox"
            checked={enableMemory}
            onChange={(event) => onEnableMemoryChange(event.target.checked)}
            disabled={isCreating}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">
              {t('projectWizard.step2.enableMemory')}
            </span>
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              {t('projectWizard.step2.memoryHelp')}
            </span>
          </span>
        </label>
      </div>

      {showGithubAuth && (
        <GithubAuthenticationCard
          tokenMode={tokenMode}
          selectedGithubToken={selectedGithubToken}
          newGithubToken={newGithubToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedGithubTokenChange={onSelectedGithubTokenChange}
          onNewGithubTokenChange={onNewGithubTokenChange}
        />
      )}
    </div>
  );
}
