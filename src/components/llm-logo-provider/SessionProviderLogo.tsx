import type { LLMProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import OpenCodeLogo from './OpenCodeLogo';
import GrokLogo from './GrokLogo';
import KimiLogo from './KimiLogo';
import AgyLogo from './AgyLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  if (provider === 'grok') {
    return <GrokLogo className={className} />;
  }

  if (provider === 'kimi') {
    return <KimiLogo className={className} />;
  }

  if (provider === 'agy') {
    return <AgyLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
