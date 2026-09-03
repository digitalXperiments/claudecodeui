import { GitBranch } from 'lucide-react';

type GitRepositoryErrorStateProps = {
  error: string;
  details?: string;
  onInitializeGit?: () => Promise<boolean>;
  isInitializingGit?: boolean;
};

export default function GitRepositoryErrorState({
  error,
  details,
  onInitializeGit,
  isInitializingGit = false,
}: GitRepositoryErrorStateProps) {
  const canInitializeGit = error.toLowerCase().includes('not a git repository');

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-muted-foreground">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
        <GitBranch className="h-8 w-8 opacity-40" />
      </div>
      <h3 className="mb-3 text-center text-lg font-medium text-foreground">{error}</h3>
      {details && (
        <p className="mb-6 max-w-md text-center text-sm leading-relaxed">{details}</p>
      )}
      {canInitializeGit && onInitializeGit && (
        <button
          type="button"
          className="mb-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => {
            void onInitializeGit();
          }}
          disabled={isInitializingGit}
        >
          {isInitializingGit ? 'Initializing Git…' : 'Initialize Git repository'}
        </button>
      )}
      <div className="max-w-md rounded-xl border border-primary/10 bg-primary/5 p-4">
        <p className="text-center text-sm text-primary">
          <strong>Tip:</strong> Run{' '}
          <code className="rounded-md bg-primary/10 px-2 py-1 font-mono text-xs">git init</code>{' '}
          in your project directory to initialize git source control.
        </p>
      </div>
    </div>
  );
}
