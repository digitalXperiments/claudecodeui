type AnyRecord = Record<string, unknown>;

/**
 * Per-provider wiring that turns a gateway-bound run into an *enforced* one: the provider must
 * see only `cloudcli-tool-gateway` (no native MCP config, no cloud connectors) and must route its
 * built-in tools (shell, file edits, web fetch) through `options.builtinToolGate`.
 */
export interface ProviderGatewayAdapter {
  /**
   * Adjust runtime options for a gateway-bound run. Called by buildRuntimeOptions after the
   * generic gateway options (mcpServers = [gateway], strictMcpSelection, botGatewayStrict) are set.
   */
  applyRunOptions?(options: AnyRecord): void;
  /** True when a run with these guards is fully governed by the gate on this provider. */
  enforced(run: { builtinToolGate?: boolean }): boolean;
  /** One line for the UI / ENFORCEMENT.md explaining how (or why not) this provider is enforced. */
  describe(run: { builtinToolGate?: boolean }): string;
}
