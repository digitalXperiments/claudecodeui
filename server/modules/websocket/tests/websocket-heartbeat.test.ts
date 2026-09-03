import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

import { attachWebSocketHeartbeat } from '@/modules/websocket/services/websocket-server.service.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  pingCount = 0;
  terminated = false;

  ping(): void {
    this.pingCount += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('heartbeat pings an open socket and terminates it after a missed pong', () => {
  const timers: Array<() => void> = [];
  const scheduler = {
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return timers.length as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {},
  };
  const socket = new FakeSocket();

  attachWebSocketHeartbeat(socket as unknown as WebSocket, 30_000, scheduler);

  timers[0]?.();
  assert.equal(socket.pingCount, 1);
  assert.equal(socket.terminated, false);

  timers[0]?.();
  assert.equal(socket.terminated, true);
});

test('a pong keeps the socket alive across ticks', () => {
  const timers: Array<() => void> = [];
  const scheduler = {
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return timers.length as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {},
  };
  const socket = new FakeSocket();

  attachWebSocketHeartbeat(socket as unknown as WebSocket, 30_000, scheduler);

  timers[0]?.();
  socket.emit('pong');
  timers[0]?.();
  assert.equal(socket.terminated, false);
  assert.equal(socket.pingCount, 2);
});
