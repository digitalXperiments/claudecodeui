import {
  OpenCodeMcpProvider,
  type OpenCodeMcpProviderOptions,
} from '@/modules/providers/list/opencode/opencode-mcp.provider.js';
import { getKiloConfigDirectory } from '@/shared/utils.js';

const KILO_MCP_OPTIONS: OpenCodeMcpProviderOptions = {
  provider: 'kilo',
  configDirectory: getKiloConfigDirectory(),
  configFileName: 'kilo',
};

/** Kilo supports the OpenCode-compatible local/remote MCP config shape. */
export class KiloMcpProvider extends OpenCodeMcpProvider {
  constructor() {
    super(KILO_MCP_OPTIONS);
  }
}
