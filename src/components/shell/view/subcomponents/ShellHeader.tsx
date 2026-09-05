import { RotateCcw, X } from 'lucide-react';

type ShellHeaderProps = {
  isConnected: boolean;
  isInitialized: boolean;
  isRestarting: boolean;
  hasSession: boolean;
  sessionDisplayNameShort: string | null;
  onDisconnect: () => void;
  onRestart: () => void;
  statusNewSessionText: string;
  statusInitializingText: string;
  statusRestartingText: string;
  disconnectLabel: string;
  disconnectTitle: string;
  restartLabel: string;
  restartTitle: string;
  disableRestart: boolean;
};

export default function ShellHeader({
  isConnected,
  isInitialized,
  isRestarting,
  hasSession,
  sessionDisplayNameShort,
  onDisconnect,
  onRestart,
  statusNewSessionText,
  statusInitializingText,
  statusRestartingText,
  disconnectLabel,
  disconnectTitle,
  restartLabel,
  restartTitle,
  disableRestart,
}: ShellHeaderProps) {
  return (
    <div className="flex-shrink-0 border-b border-border bg-muted/50 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />

          {hasSession && sessionDisplayNameShort && (
            <span className="text-xs text-primary">({sessionDisplayNameShort}...)</span>
          )}

          {!hasSession && <span className="text-xs text-muted-foreground">{statusNewSessionText}</span>}

          {!isInitialized && <span className="text-xs text-amber-600 dark:text-yellow-400">{statusInitializingText}</span>}

          {isRestarting && <span className="text-xs text-primary">{statusRestartingText}</span>}
        </div>

        <div className="flex items-center gap-2">
          {isConnected && (
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white transition-colors hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-400/70 focus:ring-offset-2 focus:ring-offset-background"
              title={disconnectTitle}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{disconnectLabel}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onRestart}
            disabled={disableRestart}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/70 px-3 text-xs font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-60"
            title={restartTitle}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${isRestarting ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{restartLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
