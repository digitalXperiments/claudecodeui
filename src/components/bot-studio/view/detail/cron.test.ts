import test from 'node:test';
import assert from 'node:assert/strict';

import { cronSummary, presetForCron, validateCron } from './cron';

test('cron presets map to raw cron and back', () => {
  assert.equal(presetForCron('*/15 * * * *')?.id, '15m');
  assert.equal(presetForCron('')?.id, 'manual');
  assert.equal(cronSummary('0 9-19 * * 1-5'), 'Every hour, Monday through Friday, 09:00–19:00');
  assert.equal(cronSummary('7 14 * * *'), 'Custom schedule · 7 14 * * *');
});

test('cron validation requires five fields and valid ranges', () => {
  assert.equal(validateCron(''), null);
  assert.equal(validateCron('0 9 * * 1'), null);
  assert.match(validateCron('0 9 * *') ?? '', /five cron fields/);
  assert.match(validateCron('60 * * * *') ?? '', /between 0 and 59/);
  assert.match(validateCron('0 9 * nope 1') ?? '', /unsupported characters/);
});
