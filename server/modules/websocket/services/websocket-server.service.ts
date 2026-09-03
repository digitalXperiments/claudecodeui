import type { Server as HttpServer } from 'node:http';

import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

type HeartbeatScheduler = {
  setInterval: (fn: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
};

/**
 * Ping/pong heartbeat. A socket that misses a pong is half-open from the
 * server's perspective; terminate it so clients can reconnect.
 */
export function attachWebSocketHeartbeat(
  ws: WebSocket,
  intervalMs = 30_000,
  scheduler: HeartbeatScheduler = { setInterval, clearInterval },
): () => void {
  let isAlive = true;
  let stopped = false;

  const markAlive = () => {
    isAlive = true;
  };

  const stopHeartbeat = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    scheduler.clearInterval(heartbeat);
    ws.off('pong', markAlive);
    ws.off('close', stopHeartbeat);
    ws.off('error', stopHeartbeat);
  };

  ws.on('pong', markAlive);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);

  const heartbeat = scheduler.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!isAlive) {
      stopHeartbeat();
      ws.terminate();
      return;
    }
    isAlive = false;
    try {
      ws.ping();
    } catch {
      stopHeartbeat();
      ws.terminate();
    }
  }, intervalMs);

  return stopHeartbeat;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });

  wss.on('connection', (ws, request) => {
    // Keep WebSocket alive across reverse-proxy idle timeouts (Cloudflare ~100s,
    // AWS ALB 60s, nginx 60s, etc.). Without app-level pings these connections
    // are silently torn down even when the UI is active, causing repeated
    // reconnect cycles. Terminate sockets that miss a pong.
    attachWebSocketHeartbeat(ws);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(ws, dependencies.shell);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname === '/desktop-notifications') {
      handleDesktopNotificationsConnection(ws, incomingRequest);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
