import type { BotAutonomy, BotGateLevel } from '../types/botRuntime';
import { permissionModeReason, permissionModeWords } from '../view/tabs/runtime/abilities/abilitiesModel';

/**
 * The provider's own permission setting, shown only when it actually decides something: the bot is
 * Bypass (no gate), or its provider is one the gate can only advise. Otherwise it renders nothing,
 * because the action gate is in charge and this setting would only be noise.
 */
export default function PermissionModeCard({ provider, autonomy, level, value, onChange }: {
  provider: string;
  autonomy: BotAutonomy;
  level: BotGateLevel | null;
  value: string;
  onChange: (mode: string) => void;
}) {
  const reason = permissionModeReason(autonomy, level, provider);
  if (!reason) return null;
  const strong = autonomy === 'bypass';
  return (
    <div className={`rounded-xl border p-4 ${strong ? 'border-red-500/40 bg-red-500/[0.06]' : 'border-amber-500/30 bg-amber-500/[0.06]'}`}>
      <p className="text-xs font-semibold text-foreground">What {provider} may do on its own</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{reason}</p>
      <select aria-label="Provider permission mode" className="field mt-3" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="default">Ask when needed (a bot has nobody to answer, so those actions do not happen)</option>
        <option value="acceptEdits">Accept file edits without asking</option>
        <option value="bypassPermissions">Skip the provider's questions (it can do everything it is able to)</option>
        <option value="plan">Plan only (read-only, changes nothing)</option>
      </select>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{permissionModeWords(value)}</p>
    </div>
  );
}
