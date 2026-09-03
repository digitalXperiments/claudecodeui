import type { McAction } from '../api/missionControlApi';

export type ActionSemantics = {
  scope: 'draft' | 'local' | 'remote' | 'configured';
  detail: string;
  confirmation: string | null;
};

function actionText(action: McAction): string {
  return `${action.id} ${action.label} ${action.kind}`.toLowerCase();
}

export function getActionSemantics(action: McAction, itemTitle: string): ActionSemantics {
  const text = actionText(action);

  if (/draft[\s_-]*(a[\s_-]*)?reply|reply[\s_-]*draft/.test(text)) {
    return {
      scope: 'draft',
      detail: 'Creates or refreshes a draft · nothing is sent',
      confirmation: null,
    };
  }

  if (action.kind === 'dismiss' || /\bdismiss\b/.test(text)) {
    return {
      scope: 'local',
      detail: 'Local only · the source is unchanged',
      confirmation: null,
    };
  }

  if (action.kind === 'delete' || /\bdelete\b/.test(text)) {
    return {
      scope: 'local',
      detail: 'Deletes this local Action Centre item',
      confirmation: `Delete “${itemTitle}” permanently?\n\nThis only deletes the local Action Centre item and frees its dedupe key. Dismiss keeps the key and blocks re-creation.`,
    };
  }

  const sendsReply = /\bsend\b.*\brepl(?:y|ies)\b|\brepl(?:y|ies)\b.*\bsend\b/.test(text);
  const remoteMutation = sendsReply || /\barchive\b|mark[\s_-]*(as[\s_-]*)?read/.test(text);
  if (remoteMutation || action.style === 'destructive') {
    const operation = sendsReply
      ? 'send this reply'
      : /\barchive\b/.test(text)
        ? 'archive this item at its source'
        : /mark[\s_-]*(as[\s_-]*)?read/.test(text)
          ? 'mark this item read at its source'
          : `run “${action.label}”`;
    return {
      scope: 'remote',
      detail: sendsReply ? 'Remote action · sends the reply now' : 'Remote action · updates the source',
      confirmation: `Confirm you want to ${operation}.\n\nThis changes the connected source and may not be reversible from Action Centre.`,
    };
  }

  if (action.kind === 'work') {
    return {
      scope: 'local',
      detail: 'Opens a local work session',
      confirmation: null,
    };
  }

  return {
    scope: 'configured',
    detail: 'Runs the configured approval action',
    confirmation: null,
  };
}
