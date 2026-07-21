import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStoredImageRecords,
  isAllowedAttachmentMimeType,
  isAllowedImageMimeType,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.cloudcli', 'assets');

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('isAllowedAttachmentMimeType accepts images, documents, and known extensions', () => {
  // Images stay allowed.
  assert.equal(isAllowedAttachmentMimeType('image/png'), true);
  // Documents by mime type.
  assert.equal(isAllowedAttachmentMimeType('application/pdf'), true);
  assert.equal(isAllowedAttachmentMimeType('text/csv'), true);
  assert.equal(
    isAllowedAttachmentMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    true,
  );
  // Browsers often send octet-stream for office files: fall back to extension.
  assert.equal(isAllowedAttachmentMimeType('application/octet-stream', 'budget.xlsx'), true);
  assert.equal(isAllowedAttachmentMimeType('application/octet-stream', 'notes.md'), true);
  // Unknown mime with an unlisted/dangerous extension is rejected.
  assert.equal(isAllowedAttachmentMimeType('application/octet-stream', 'malware.exe'), false);
  assert.equal(isAllowedAttachmentMimeType('application/x-sh', 'run.sh'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});
