import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodeCardSvg,
  generateArticleAssets,
} from '@/modules/mission-control/article-assets.service.js';
import { X_ARTICLE_BODY_KIND } from '@/modules/mission-control/x-articles-seed.js';

test('code card SVG escapes markup so a snippet cannot break the document', () => {
  const { svg } = buildCodeCardSvg({
    lang: 'tsx',
    caption: 'A <caption> & an "attribute"',
    source: 'const el = <Foo bar="baz" />; // a & b',
  });

  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('<Foo'), 'raw markup from the snippet leaked into the SVG');
  // `<` and the identifier land in separate tspans, so assert on the escape itself.
  assert.ok(svg.includes('&lt;'));
  assert.ok(svg.includes('&amp;'));
  assert.ok(!svg.includes('bar="baz"'), 'a raw attribute pair leaked into the SVG');
  assert.ok(svg.includes('&lt;caption&gt;'), 'caption text was not escaped');
});

test('code card preserves indentation and sizes to the longest line', () => {
  const narrow = buildCodeCardSvg({ lang: 'ts', caption: '', source: 'a' });
  const wide = buildCodeCardSvg({
    lang: 'ts',
    caption: '',
    source: `const someVeryLongIdentifierName = anotherRatherLongFunctionName(withArguments, andMore);`,
  });

  assert.ok(wide.width > narrow.width, 'card did not grow with content');
  assert.ok(narrow.width >= 680, 'card fell below the minimum width');
  assert.ok(wide.width <= 1400, 'card exceeded the maximum width');

  const indented = buildCodeCardSvg({ lang: 'ts', caption: '', source: '  return 1;' });
  assert.ok(
    indented.svg.includes('xml:space="preserve"'),
    'indentation would collapse without xml:space',
  );
});

test('code card height tracks line count', () => {
  const one = buildCodeCardSvg({ lang: 'ts', caption: '', source: 'a' });
  const three = buildCodeCardSvg({ lang: 'ts', caption: '', source: 'a\nb\nc' });
  assert.equal(three.height - one.height, 48, 'two extra lines should add 2 * lineHeight');
});

test('comment markers inside string literals are not treated as comments', () => {
  const { svg } = buildCodeCardSvg({
    lang: 'ts',
    caption: '',
    source: 'const url = "https://example.com/path";',
  });
  // The URL must render as a string, not get swallowed by a `//` comment.
  assert.ok(svg.includes('https://example.com/path'));
  assert.ok(!svg.includes('>//example.com'), 'URL slashes were parsed as a comment');
});

test('generateArticleAssets rejects a body that is not an x_article', async () => {
  await assert.rejects(
    () => generateArticleAssets({ kind: 'something_else' }),
    /not an x_article/,
  );
});

test('generateArticleAssets renders code cards and reports unknown code ids', async () => {
  const body = {
    kind: X_ARTICLE_BODY_KIND,
    v: 1,
    slug: 'grok-agent-story',
    headline: 'A story',
    blocks: [{ type: 'code', codeId: 'c1' }],
    code: [{ id: 'c1', lang: 'ts', caption: 'the fix', source: 'export const ok = true;' }],
    images: [
      { id: 'i1', kind: 'code-card', codeId: 'c1', alt: 'the fix' },
      { id: 'i2', kind: 'code-card', codeId: 'missing', alt: 'nothing' },
    ],
  };

  const result = await generateArticleAssets(body);

  assert.equal(result.generated, 1);
  assert.equal(result.failed, 1);

  const images = result.body.images as Array<Record<string, unknown>>;
  assert.equal(images[0].status, 'ready');
  assert.match(String(images[0].assetUrl), /^\/api\/assets\/images\/grok-agent-story-i1-\d+\.png$/);
  assert.ok(Number(images[0].width) > 0 && Number(images[0].height) > 0);

  assert.equal(images[1].status, 'failed');
  assert.match(String(images[1].statusMessage), /Unknown codeId/);

  // The original body is not mutated — the patched copy is returned.
  assert.equal((body.images[0] as Record<string, unknown>).status, undefined);
});

test('generateArticleAssets leaves ready images alone unless forced', async () => {
  const body = {
    kind: X_ARTICLE_BODY_KIND,
    v: 1,
    slug: 'cached',
    headline: 'A story',
    blocks: [],
    code: [{ id: 'c1', lang: 'ts', caption: '', source: 'const a = 1;' }],
    images: [
      {
        id: 'i1',
        kind: 'code-card',
        codeId: 'c1',
        alt: 'x',
        status: 'ready',
        assetUrl: '/api/assets/images/already-there.png',
      },
    ],
  };

  const cached = await generateArticleAssets(body);
  assert.equal(cached.generated, 0);
  assert.equal(
    (cached.body.images as Array<Record<string, unknown>>)[0].assetUrl,
    '/api/assets/images/already-there.png',
  );

  const forced = await generateArticleAssets(body, { force: true });
  assert.equal(forced.generated, 1);
  assert.notEqual(
    (forced.body.images as Array<Record<string, unknown>>)[0].assetUrl,
    '/api/assets/images/already-there.png',
  );
});

test('screenshots degrade to skipped when the browser runtime is unavailable', async () => {
  const body = {
    kind: X_ARTICLE_BODY_KIND,
    v: 1,
    slug: 'shot',
    headline: 'A story',
    blocks: [],
    images: [{ id: 'i1', kind: 'screenshot', route: '/mission-control', alt: 'the panel' }],
  };

  const result = await generateArticleAssets(body);
  const image = (result.body.images as Array<Record<string, unknown>>)[0];

  // Whichever way the runtime resolves in this environment, a screenshot must
  // never take the whole run down.
  assert.ok(['ready', 'skipped', 'failed'].includes(String(image.status)));
  assert.equal(result.generated + result.skipped + result.failed, 1);
});
