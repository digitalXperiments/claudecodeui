import { CheckCircle2, CircleAlert } from 'lucide-react';

import type { AgentRelayJob } from '../../../agent-relay/types';

type AgentRelayResultDetailsProps = {
  result: NonNullable<AgentRelayJob['result']>;
};

const jsonText = (value: unknown) => {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

function ResultList({ label, values, empty = 'None recorded.' }: { label: string; values: string[]; empty?: string }) {
  return (
    <div>
      <div className="font-medium text-foreground">{label}</div>
      {values.length > 0 ? (
        <ul className="mt-0.5 list-inside list-disc space-y-0.5">
          {values.map((value, index) => <li key={`${value}-${index}`} className="break-words">{value}</li>)}
        </ul>
      ) : <div className="mt-0.5 text-muted-foreground">{empty}</div>}
    </div>
  );
}

export default function AgentRelayResultDetails({ result }: AgentRelayResultDetailsProps) {
  const structuredOutput = jsonText(result.structuredOutput);
  const validation = result.outputValidation;

  return (
    <details className="mt-2 rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium text-foreground">Full result</summary>
      <div className="mt-2 space-y-2 leading-4">
        <ResultList label="Evidence" values={result.evidence} />
        <ResultList label="Files touched" values={result.filesTouched} />
        <ResultList label="Tests run" values={result.testsRun} />
        <ResultList label="Open questions" values={result.openQuestions} empty="No open questions." />

        <div>
          <div className="font-medium text-foreground">Schema verdict</div>
          {validation ? (
            <div className="mt-0.5 flex items-start gap-1">
              {validation.valid
                ? <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-500" aria-hidden="true" />
                : <CircleAlert className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" aria-hidden="true" />}
              <span>{validation.valid ? 'Valid structured output.' : `Invalid structured output${validation.errors.length ? `: ${validation.errors.join('; ')}` : '.'}`}</span>
            </div>
          ) : <div className="mt-0.5">No output schema verdict recorded.</div>}
        </div>

        <div>
          <div className="font-medium text-foreground">Structured output</div>
          {structuredOutput ? (
            <pre className="mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-1.5 font-mono text-[9px]">{structuredOutput}</pre>
          ) : <div className="mt-0.5">No structured output recorded.</div>}
        </div>

        <div>
          <div className="font-medium text-foreground">Raw output</div>
          {result.output ? (
            <pre className="mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-1.5 font-mono text-[9px]">{result.output}</pre>
          ) : <div className="mt-0.5">No raw output recorded.</div>}
        </div>
      </div>
    </details>
  );
}
