import { KeyRound } from 'lucide-react';

import type { BotAbilities } from '../../../../types/botRuntime';
import CredentialsCard from '../rules/CredentialsCard';

import AbilityCard from './AbilityCard';
import BrowserCard from './BrowserCard';

/** Section 5: this bot's own logins: API keys for its apps and the websites it is signed in to. */
export default function AccountsSection({ botId, botTitle, abilities, serverSuggestions, now, onChanged }: {
  botId: string;
  botTitle: string;
  abilities: BotAbilities | null;
  serverSuggestions: string[];
  now: number;
  onChanged: () => void;
}) {
  return (
    <AbilityCard
      id="accounts"
      number={5}
      title="Accounts & logins"
      description="Give this bot its own logins so it does not borrow yours. Passwords and keys are stored encrypted and are never shown again, and the bot never sees them."
    >
      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><KeyRound className="h-3.5 w-3.5 text-primary" aria-hidden="true" />Keys for its apps</p>
        <CredentialsCard botId={botId} serverSuggestions={serverSuggestions} now={now} />
      </div>
      <BrowserCard botId={botId} botTitle={botTitle} initial={abilities?.browser ?? null} onChanged={onChanged} />
    </AbilityCard>
  );
}
