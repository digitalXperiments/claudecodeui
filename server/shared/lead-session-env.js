/**
 * Environment stamp that tells CloudCLI-managed MCP servers which chat session
 * they are serving.
 *
 * Provider CLIs spawn their stdio MCP children with an inherited environment,
 * so a value placed on the CLI's spawn env reaches every MCP server that run
 * launches. The Agent Relay MCP reads it to attribute a delegation to the lead
 * chat that asked for it.
 *
 * This must travel on the per-spawn env, never on `process.env`: the server
 * process runs many chat sessions concurrently, and a process-wide value would
 * hand every relay the wrong owner.
 *
 * @param {string | null | undefined} appSessionId Stable CloudCLI session id.
 * @returns {Record<string, string>} Env additions, empty when there is no session.
 */
export function leadSessionEnv(appSessionId) {
  return typeof appSessionId === 'string' && appSessionId.trim()
    ? { CLOUDCLI_LEAD_SESSION_ID: appSessionId.trim() }
    : {};
}
