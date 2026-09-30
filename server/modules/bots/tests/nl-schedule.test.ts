import assert from 'node:assert/strict';
import test from 'node:test';

import { compileNaturalSchedule, isScheduleExcluded } from '@/modules/bots/signals/nl-schedule.js';

type Case = { text: string; cron: string; weekdays?: number[]; dates?: string[] };

const OK: Case[] = [
  { text: 'every minute', cron: '* * * * *' },
  { text: 'every 15 minutes', cron: '*/15 * * * *' },
  { text: 'Every 5 minutes.', cron: '*/5 * * * *' },
  { text: 'every ten minutes', cron: '*/10 * * * *' },
  { text: 'every hour', cron: '0 * * * *' },
  { text: 'hourly', cron: '0 * * * *' },
  { text: 'every 2 hours', cron: '0 */2 * * *' },
  { text: 'every six hours', cron: '0 */6 * * *' },
  { text: 'daily at 9', cron: '0 9 * * *' },
  { text: 'daily at 9am', cron: '0 9 * * *' },
  { text: 'every day at 18:30', cron: '30 18 * * *' },
  { text: 'every day at 6:05 pm', cron: '5 18 * * *' },
  { text: 'daily at noon', cron: '0 12 * * *' },
  { text: 'every day at midnight', cron: '0 0 * * *' },
  { text: 'daily at 12am', cron: '0 0 * * *' },
  { text: 'daily at 12pm', cron: '0 12 * * *' },
  { text: 'weekdays at 9am', cron: '0 9 * * 1-5' },
  { text: 'every weekday at 8:45', cron: '45 8 * * 1-5' },
  { text: 'every weekday at 9 except fridays', cron: '0 9 * * 1-5', weekdays: [5] },
  { text: 'weekdays at 9 except monday and friday', cron: '0 9 * * 1-5', weekdays: [1, 5] },
  { text: 'daily at 9 excluding 2026-12-25', cron: '0 9 * * *', dates: ['2026-12-25'] },
  { text: 'every day at 9 but not on sundays and 2026-01-01', cron: '0 9 * * *', weekdays: [0], dates: ['2026-01-01'] },
  { text: 'mondays and thursdays at 10:15', cron: '15 10 * * 1,4' },
  { text: 'every monday and wednesday at 7pm', cron: '0 19 * * 1,3' },
  { text: 'weekends at 11', cron: '0 11 * * 0,6' },
  { text: 'every monday at 8pm', cron: '0 20 * * 1' },
  { text: 'every tue at 14:00', cron: '0 14 * * 2' },
  { text: 'sundays at 7am', cron: '0 7 * * 0' },
  { text: 'first day of the month at 8', cron: '0 8 1 * *' },
  { text: 'first day of every month at 8:30am', cron: '30 8 1 * *' },
  { text: 'last day of the month at 17', cron: '0 17 L * *' },
  { text: 'on the 15th of the month at 9', cron: '0 9 15 * *' },
  { text: 'twice a day', cron: '0 9,17 * * *' },
  { text: 'twice daily', cron: '0 9,17 * * *' },
  { text: 'daily at 8 and 20', cron: '0 8,20 * * *' },
  { text: 'weekdays', cron: '0 9 * * 1-5' },
  { text: '  DAILY   AT   7  ', cron: '0 7 * * *' },
];

for (const c of OK) {
  test(`nl-schedule compiles "${c.text}"`, () => {
    const result = compileNaturalSchedule(c.text);
    assert.ok(!('error' in result), 'error' in result ? result.error : '');
    assert.equal(result.cron, c.cron);
    assert.deepEqual(result.exclusions.weekdays, c.weekdays);
    assert.deepEqual(result.exclusions.dates, c.dates);
    assert.ok(result.description.length > 5);
  });
}

const BAD: Array<[string, RegExp]> = [
  ['', /Describe a schedule/],
  ['whenever you feel like it', /Could not understand/],
  ['every 90 minutes', /between 1 and 59/],
  ['every 30 hours', /between 1 and 23/],
  ['daily at 25', /Could not read the time/],
  ['daily at 13pm', /Could not read the time/],
  ['daily at 9:75', /Could not read the time/],
  ['daily at 9:00 and 17:30', /same minute/],
  ['weekdays at 9 except someday', /Could not read the exclusion/],
  ['daily at 9 except 2026-13-45', /not a valid date/],
  ['on the 40th of the month at 9', /out of range/],
];

for (const [text, pattern] of BAD) {
  test(`nl-schedule rejects "${text}" with a helpful message`, () => {
    const result = compileNaturalSchedule(text);
    assert.ok('error' in result);
    assert.match(result.error, pattern);
  });
}

test('nl-schedule echoes the timezone and human description', () => {
  const result = compileNaturalSchedule('weekdays at 9am except fridays', 'Asia/Dubai');
  assert.ok(!('error' in result));
  assert.equal(result.timezone, 'Asia/Dubai');
  assert.match(result.description, /09:00/);
  assert.match(result.description, /weekdays/);
  assert.match(result.description, /except Friday/);
});

test('isScheduleExcluded evaluates weekdays and dates in the schedule timezone', () => {
  // 2026-09-25 is a Friday (UTC). 23:30 UTC is already Saturday in Dubai (UTC+4).
  const fridayLateUtc = new Date('2026-09-25T23:30:00Z');
  assert.equal(isScheduleExcluded({ weekdays: [5] }, fridayLateUtc, 'UTC'), true);
  assert.equal(isScheduleExcluded({ weekdays: [5] }, fridayLateUtc, 'Asia/Dubai'), false);
  assert.equal(isScheduleExcluded({ weekdays: [6] }, fridayLateUtc, 'Asia/Dubai'), true);
  assert.equal(isScheduleExcluded({ dates: ['2026-09-26'] }, fridayLateUtc, 'Asia/Dubai'), true);
  assert.equal(isScheduleExcluded({ dates: ['2026-09-26'] }, fridayLateUtc, 'UTC'), false);
  assert.equal(isScheduleExcluded({}, fridayLateUtc, 'UTC'), false);
  assert.equal(isScheduleExcluded(undefined, fridayLateUtc), false);
  // Invalid tz falls back to the server zone rather than throwing.
  assert.doesNotThrow(() => isScheduleExcluded({ weekdays: [1] }, fridayLateUtc, 'Not/AZone'));
});
