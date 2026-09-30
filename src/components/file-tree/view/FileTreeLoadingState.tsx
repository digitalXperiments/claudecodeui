import { useTranslation } from 'react-i18next';

type FileTreeLoadingStateProps = {
  error?: string | null;
  onRetry?: () => void;
};

export default function FileTreeLoadingState({ error, onRetry }: FileTreeLoadingStateProps) {
  const { t } = useTranslation();

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <div className="text-sm text-muted-foreground">{error}</div>
        {onRetry && (
          <button type="button" onClick={onRetry} className="text-sm text-primary hover:underline">
            {t('fileTree.retry', 'Retry')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-sm text-muted-foreground">{t('fileTree.loading')}</div>
    </div>
  );
}
