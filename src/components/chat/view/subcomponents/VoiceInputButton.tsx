import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2 } from 'lucide-react';

import { PromptInputButton } from '../../../../shared/view/ui';
import type { VoiceInputState } from '../../hooks/useVoiceInput';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  errorMsg?: string | null;
  /** When false, show a disabled mic that explains how to enable voice. */
  available?: boolean;
  disabledReason?: string | null;
};

// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
export default function VoiceInputButton({
  state,
  onToggle,
  errorMsg,
  available = true,
  disabledReason = null,
}: Props) {
  const { t } = useTranslation('chat');

  const icon =
    state === 'recording' ? (
      <Square className="text-red-500" />
    ) : state === 'transcribing' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic className={!available ? 'opacity-50' : undefined} />
    );

  const tooltip = !available
    ? disabledReason ||
      t('voice.enableInSettings', {
        defaultValue: 'Enable Voice in Settings → Voice, then configure a backend',
      })
    : state === 'recording'
      ? t('voice.stopRecording')
      : t('voice.input');

  return (
    <span className="relative inline-flex">
      {errorMsg && (
        <span className="absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {errorMsg}
        </span>
      )}
      <PromptInputButton
        tooltip={{ content: tooltip }}
        disabled={!available && state === 'idle'}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          if (!available && state === 'idle') {
            return;
          }
          onToggle();
        }}
        aria-label={tooltip}
      >
        {icon}
      </PromptInputButton>
    </span>
  );
}
