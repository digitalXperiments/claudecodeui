import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const match = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
assert.ok(match, 'mweb inline script is present');
const source = match[1];

parse(source, { ecmaVersion: 5 });
for (const route of [
  '/api/agent-relay/jobs',
  '/api/agent-relay/approvals',
  '/peek',
  '/cancel',
  '/follow-up',
  '/decide',
]) {
  assert.ok(source.includes(route), `Relay route is covered: ${route}`);
}
assert.ok(!source.includes('fetch('), 'mweb uses the legacy XHR helper');
assert.ok(!source.includes('Promise'), 'mweb does not require Promise support');
assert.match(html, /id="screenRelay"/);
assert.match(html, /id="relayScopeSelect"/);
assert.match(html, /id="relayStatusSelect"/);
console.log('mweb legacy Relay check passed');
