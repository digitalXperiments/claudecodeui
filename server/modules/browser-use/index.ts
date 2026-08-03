// Headless browser runtime (playwright + chromium, installed on demand):
// the agent-facing MCP surface, the settings/session REST routes, and the
// service other modules use to drive a page or capture a frame.
export { default as browserUseRoutes } from './browser-use.routes.js';
export { default as browserUseMcpRoutes } from './browser-use-mcp.routes.js';
export { browserUseService } from './browser-use.service.js';
