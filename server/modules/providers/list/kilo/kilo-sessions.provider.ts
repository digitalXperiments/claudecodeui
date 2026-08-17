import {
  OpenCodeSessionsProvider,
  type OpenCodeSessionsProviderOptions,
} from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { getKiloDatabasePath } from '@/shared/utils.js';

const KILO_SESSION_OPTIONS: OpenCodeSessionsProviderOptions = {
  provider: 'kilo',
  databasePath: getKiloDatabasePath(),
};

/** Kilo persists the same message/part/session tables in its own kilo.db. */
export class KiloSessionsProvider extends OpenCodeSessionsProvider {
  constructor() {
    super(KILO_SESSION_OPTIONS);
  }
}
