import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Mic, MonitorSpeaker } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { PromptInputButton } from '../../../../shared/view/ui';
import { useVoiceConfig } from '../../../../hooks/useVoiceConfig';
import { cn } from '../../../../lib/utils';

type MicDevice = { deviceId: string; label: string };

// Chrome/macOS expose synthetic aggregate entries in addition to the real devices; they
// duplicate a physical mic and only confuse the list, so drop them — our own
// "System default" row already covers "follow the OS setting".
const SYNTHETIC_IDS = new Set(['default', 'communications']);

// Meet/Zoom-style mic chooser: a compact caret next to the voice button that opens a menu
// of audio input devices. Selecting one pins recording to that mic (persisted in
// voiceConfig.inputDeviceId); "System default" clears it so the OS default is used.
export default function MicDevicePicker({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('chat');
  const { config, update } = useVoiceConfig();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const seen = new Set<string>();
      const mics: MicDevice[] = [];
      for (const d of list) {
        if (d.kind !== 'audioinput') continue;
        if (SYNTHETIC_IDS.has(d.deviceId)) continue;
        if (seen.has(d.deviceId)) continue;
        seen.add(d.deviceId);
        mics.push({ deviceId: d.deviceId, label: d.label });
      }
      setDevices(mics);
      // Device labels stay blank until the page has been granted mic permission.
      setNeedsPermission(mics.length > 0 && mics.every((m) => !m.label));
    } catch {
      setDevices([]);
    }
  }, []);

  // Prompt for mic access so labels become readable (like Meet/Zoom), then re-enumerate.
  const grantAndRefresh = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tk) => tk.stop());
    } catch {
      /* denied — leave labels blank */
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open, refresh]);

  const select = (deviceId: string) => {
    update({ inputDeviceId: deviceId });
    setOpen(false);
  };

  const selectedId = config.inputDeviceId;
  const selectLabel = t('voice.selectMic', { defaultValue: 'Select microphone' });
  const hasCustom = Boolean(selectedId);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <PromptInputButton
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={selectLabel}
        disabled={disabled}
        className={cn('relative -ml-1 h-8 w-6 px-0', open && 'bg-accent')}
        tooltip={{ content: selectLabel }}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
        {/* Dot marks that a specific (non-default) mic is pinned. */}
        {hasCustom && (
          <span className="absolute right-0.5 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </PromptInputButton>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="animate-in fade-in-0 zoom-in-95 absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <Mic className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('voice.microphone', { defaultValue: 'Microphone' })}
            </span>
          </div>

          <div className="max-h-64 overflow-y-auto p-1.5">
            <MenuRow
              icon={MonitorSpeaker}
              label={t('voice.systemDefault', { defaultValue: 'System default' })}
              description={t('voice.systemDefaultHint', { defaultValue: 'Follows your OS setting' })}
              selected={!selectedId}
              onClick={() => select('')}
            />
            {devices.map((d, i) => (
              <MenuRow
                key={d.deviceId || `mic-${i}`}
                icon={Mic}
                label={d.label || t('voice.unnamedMic', { defaultValue: `Microphone ${i + 1}` })}
                selected={Boolean(selectedId) && selectedId === d.deviceId}
                onClick={() => select(d.deviceId)}
              />
            ))}
            {!devices.length && (
              <div className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                {t('voice.noMics', { defaultValue: 'No microphones found' })}
              </div>
            )}
          </div>

          {needsPermission && (
            <button
              type="button"
              onClick={grantAndRefresh}
              className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus:bg-accent/60 focus:outline-none"
            >
              <Mic className="h-3.5 w-3.5 flex-shrink-0" />
              {t('voice.grantMicToSeeNames', { defaultValue: 'Allow mic access to see device names' })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon: Icon,
  label,
  description,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <Icon
        className={cn(
          'h-4 w-4 flex-shrink-0',
          selected ? 'text-primary' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-5" title={label}>
          {label}
        </span>
        {description && (
          <span className="block truncate text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {selected && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
    </button>
  );
}
