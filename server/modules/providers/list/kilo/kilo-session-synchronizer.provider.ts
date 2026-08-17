import {
  OpenCodeSessionSynchronizer,
  type OpenCodeSessionSynchronizerOptions,
} from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { getKiloDatabasePath } from '@/shared/utils.js';

const KILO_SESSION_SYNCHRONIZER_OPTIONS: OpenCodeSessionSynchronizerOptions = {
  provider: 'kilo',
  databasePath: getKiloDatabasePath(),
  databaseFileName: 'kilo.db',
  fallbackTitle: 'Untitled Kilo Code Session',
  logLabel: 'KiloProvider',
};

export class KiloSessionSynchronizer extends OpenCodeSessionSynchronizer {
  constructor() {
    super(KILO_SESSION_SYNCHRONIZER_OPTIONS);
  }
}
