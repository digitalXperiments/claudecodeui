import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mwebPath = new URL('../public/mweb/index.html', import.meta.url);

test('mweb Action Centre stays iPad-friendly and uses Mission Control APIs', async () => {
  const html = await readFile(mwebPath, 'utf8');

  assert.match(html, /<div class="title">Action Centre<\/div>/);
  assert.match(html, /aria-label="Action Centre">MC<\/button>/);
  assert.doesNotMatch(html, />Review<\//);
  assert.match(html, /\/api\/mission-control\/sections/);
  assert.match(html, /\/api\/mission-control\/items\?status=pending,failed/);
  assert.match(html, /\/api\/mission-control\/items\/.*\/actions/);
  assert.match(html, /combinedActions\(section\.actions, item\.actions\)/);
  assert.match(html, /min-height: 44px/);
  assert.match(html, /touch-action: manipulation/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /constant\(safe-area-inset-bottom\)/);
  assert.match(html, /position: sticky/);
  assert.match(html, /aria-live/);
});

test('mweb Action Centre confirms risky actions but exempts Draft reply', async () => {
  const html = await readFile(mwebPath, 'utf8');

  assert.match(html, /draft\[\\s_-\]\*reply/);
  assert.match(html, /send\|archive\|mark\[\\s_-\]\*read\|delete\|destructive\|remote/);
  assert.match(html, /window\.confirm/);
  assert.match(html, /Working on/);
  assert.match(html, /Completed:/);
  assert.match(html, /Could not complete/);
});

test('mweb Action Centre runtime keeps legacy iOS JavaScript syntax', async () => {
  const html = await readFile(mwebPath, 'utf8');
  const runtime = html.split('<script>')[1].split('</script>')[0];

  assert.doesNotMatch(runtime, /\b(?:const|let)\s+/);
  assert.doesNotMatch(runtime, /=>/);
  assert.doesNotMatch(runtime, /\?\./);
  assert.doesNotMatch(runtime, /\?\?/);
  assert.doesNotMatch(runtime, /\basync\s+function\b/);
  // Backticks already occur inside the legacy Markdown regex literals; the
  // syntax checks above guard the unsupported runtime constructs we add.
});
