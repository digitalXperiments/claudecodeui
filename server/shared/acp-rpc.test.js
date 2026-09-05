import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { createAcpJsonRpcClient } from './acp-rpc.js';

/** A stand-in for a spawned ACP agent: stdout we push into, stdin we read back. */
const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', () => {});
  child.emitLine = (payload) => child.stdout.write(`${JSON.stringify(payload)}\n`);
  return child;
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('ACP JSON-RPC idle timeouts', () => {
  it('fails a wall-clock request that runs past its bound even while streaming', async () => {
    const child = fakeChild();
    const rpc = createAcpJsonRpcClient(child, { label: 'Test' });

    const pending = rpc.request('session/prompt', {}, 40);
    // Keep the agent chatty; a wall-clock bound must not care.
    const chatter = setInterval(() => child.emitLine({ jsonrpc: '2.0', method: 'session/update', params: {} }), 5);
    await assert.rejects(pending, /timed out after 40ms/);
    clearInterval(chatter);
    rpc.close();
  });

  it('keeps an idle-bounded request alive for as long as the agent keeps talking', async () => {
    const child = fakeChild();
    const rpc = createAcpJsonRpcClient(child, { label: 'Test' });

    const pending = rpc.request('session/prompt', {}, 40, { idle: true });
    // Stream for well past the 40ms budget, then answer.
    const chatter = setInterval(() => child.emitLine({ jsonrpc: '2.0', method: 'session/update', params: {} }), 10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    clearInterval(chatter);
    child.emitLine({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });

    assert.deepEqual(await pending, { stopReason: 'end_turn' });
    rpc.close();
  });

  it('still fails an idle-bounded request once the agent goes silent', async () => {
    const child = fakeChild();
    const rpc = createAcpJsonRpcClient(child, { label: 'Test' });

    const pending = rpc.request('session/prompt', {}, 40, { idle: true });
    child.emitLine({ jsonrpc: '2.0', method: 'session/update', params: {} });
    await assert.rejects(pending, /produced no output for 40ms/);
    rpc.close();
  });

  it('treats our own reply to an agent request as progress', async () => {
    const child = fakeChild();
    const rpc = createAcpJsonRpcClient(child, { label: 'Test' });

    const pending = rpc.request('session/prompt', {}, 60, { idle: true });
    // A permission round-trip: the agent asks, we answer, and the answer alone
    // must rearm the budget even though the agent stays quiet afterwards.
    child.emitLine({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    rpc.respond(99, { outcome: { outcome: 'selected' } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    child.emitLine({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });

    assert.deepEqual(await pending, { stopReason: 'end_turn' });
    rpc.close();
  });

  it('does not rearm requests that already settled', async () => {
    const child = fakeChild();
    const rpc = createAcpJsonRpcClient(child, { label: 'Test' });

    const pending = rpc.request('session/prompt', {}, 10_000, { idle: true });
    child.emitLine({ jsonrpc: '2.0', id: 1, result: {} });
    await pending;
    // A settled request must leave no timer behind to fire or rearm.
    child.emitLine({ jsonrpc: '2.0', method: 'session/update', params: {} });
    await tick();
    rpc.close();
  });
});
