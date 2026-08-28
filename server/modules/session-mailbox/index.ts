// Peer mailbox: lets a live CloudCLI chat session message another live
// session in the same project without a human relaying text between tabs.
export { default as sessionMailboxMcpRoutes } from './session-mailbox-mcp.routes.js';
export {
  sessionMailboxService,
  configureSessionMailboxRuntimes,
  SESSION_MAILBOX_MCP_SERVER_NAME,
} from './session-mailbox.service.js';
export type {
  MailboxMessage,
  MailboxMessageStatus,
  PeerSessionInfo,
  SendPeerMessageResult,
} from './session-mailbox.types.js';
