import { cn } from '../../../lib/utils';

import { resolveBotIcon } from './BotIconResolver';

export default function BotIcon({ icon, className, size }: { icon?: string | null; className?: string; size?: number | string }): JSX.Element {
  const resolved = resolveBotIcon(icon);
  if (resolved.kind === 'text') {
    return <span className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden leading-none', className)} style={size ? { width: size, height: size, fontSize: size } : undefined} aria-hidden>{resolved.value}</span>;
  }
  const Icon = resolved.value;
  return <Icon className={cn('shrink-0', className)} size={size} aria-hidden />;
}
