export interface SpendVerdict {
  spentUsd: number;
  softUsd: number | null;
  hardUsd: number | null;
  soft: boolean;
  hard: boolean;
}

export interface SessionSpendTelemetry {
  spentUsd: number;
  lastTurnCostUsd: number;
  burnRateUsdPerMin: number;
  runCount: number;
  totalTokens: number;
  verdict: SpendVerdict | null;
  isLoading: boolean;
}

export interface ContextPressureTelemetry {
  usedTokens: number;
  contextWindow: number;
  percent: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cumulativeUsed?: number;
  model?: string | null;
}

export type HeartbeatPhase = 'idle' | 'thinking' | 'tool' | 'streaming' | 'stalled';

export interface SessionHeartbeatTelemetry {
  phase: HeartbeatPhase;
  toolName: string | null;
  statusText: string | null;
  elapsedSeconds: number;
  idleSeconds: number;
  isStalled: boolean;
  canInterrupt: boolean;
  lastRunDurationSeconds: number | null;
}

export interface SessionStatusBarTelemetry {
  spend: SessionSpendTelemetry;
  context: ContextPressureTelemetry;
  heartbeat: SessionHeartbeatTelemetry;
  refresh: () => Promise<void>;
  abort: () => void;
}
