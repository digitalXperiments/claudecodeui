/**
 * Deterministic natural-language schedule compiler. Turns phrases such as
 * "every weekday at 9 except fridays" into a cron expression plus exclusions
 * that the trigger scheduler enforces at fire time. No model is involved, so
 * the compiled rule can be shown back to the operator for confirmation.
 */

import { Cron } from 'croner';

export interface ScheduleExclusions {
  /** 0 = Sunday ... 6 = Saturday. */
  weekdays?: number[];
  /** ISO dates (YYYY-MM-DD) evaluated in the schedule timezone. */
  dates?: string[];
}

export interface CompiledSchedule {
  cron: string;
  exclusions: ScheduleExclusions;
  description: string;
  timezone?: string;
}

export type NaturalScheduleResult = CompiledSchedule | { error: string };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_PATTERN =
  '(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)';
const DAY_REGEX = new RegExp(`\\b${DAY_PATTERN}s?\\b`, 'g');
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

const EXAMPLES = 'Try "every 15 minutes", "weekdays at 9am", "mondays and thursdays at 10:15" or "first day of the month at 8".';

function dayIndex(name: string): number {
  const key = name.slice(0, 3);
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(key);
}

function parseCount(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  return NUMBER_WORDS[raw] ?? null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parseDays(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(DAY_REGEX)) {
    const idx = dayIndex(match[0]);
    if (idx >= 0) found.add(idx);
  }
  return [...found].sort((a, b) => a - b);
}

interface TimeOfDay {
  hour: number;
  minute: number;
}

function parseOneTime(raw: string): TimeOfDay | null {
  const token = raw.trim();
  if (token === 'noon') return { hour: 12, minute: 0 };
  if (token === 'midnight') return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(token);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.replace(/\./g, '');
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

const TIME_TOKEN = '(?:noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?)';

/** Finds "at 9", "at 9 and 17", "8pm", "18:30" in a phrase. Returns null when no time is present. */
function extractTimes(text: string): { times: TimeOfDay[] } | { error: string } | null {
  const atMatch = new RegExp(`(?:\\bat\\s+|@\\s*)(${TIME_TOKEN}(?:\\s*(?:,|and|&)\\s*${TIME_TOKEN})*)`).exec(text);
  let source = atMatch?.[1];
  if (!source) {
    const bare = new RegExp(`\\b(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)|\\d{1,2}:\\d{2}|noon|midnight)\\b`).exec(text);
    source = bare?.[1];
  }
  if (!source) return null;
  const parts = source.split(/\s*(?:,|and|&)\s*/).filter(Boolean);
  const times: TimeOfDay[] = [];
  for (const part of parts) {
    const parsed = parseOneTime(part);
    if (!parsed) return { error: `Could not read the time "${part.trim()}". Use forms like 9, 9am, 18:30 or noon.` };
    times.push(parsed);
  }
  return { times };
}

function describeTime(times: TimeOfDay[]): string {
  return times.map((t) => `${pad(t.hour)}:${pad(t.minute)}`).join(' and ');
}

function describeDays(days: number[]): string {
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

function compressDays(days: number[]): string {
  const key = days.join(',');
  if (key === '1,2,3,4,5') return '1-5';
  return key;
}

function validateCron(cron: string): string | null {
  try {
    new Cron(cron, { paused: true }).stop();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseExclusions(tail: string): ScheduleExclusions | { error: string } {
  const weekdays = parseDays(tail);
  const dates = [...tail.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map((m) => m[0]);
  for (const date of dates) {
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { error: `"${date}" is not a valid date (use YYYY-MM-DD).` };
  }
  if (weekdays.length === 0 && dates.length === 0) {
    return { error: `Could not read the exclusion "${tail.trim()}". Name weekdays (fridays) or ISO dates (2026-12-25).` };
  }
  const out: ScheduleExclusions = {};
  if (weekdays.length) out.weekdays = weekdays;
  if (dates.length) out.dates = [...new Set(dates)].sort();
  return out;
}

function describeExclusions(ex: ScheduleExclusions): string {
  const parts: string[] = [];
  if (ex.weekdays?.length) parts.push(describeDays(ex.weekdays));
  if (ex.dates?.length) parts.push(ex.dates.join(', '));
  return parts.length ? `, except ${parts.join(' and ')}` : '';
}

export function compileNaturalSchedule(text: string, tz?: string): NaturalScheduleResult {
  const original = typeof text === 'string' ? text : '';
  let t = original.toLowerCase().replace(/[.!]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return { error: `Describe a schedule. ${EXAMPLES}` };
  const timezone = tz?.trim() || undefined;

  let exclusions: ScheduleExclusions = {};
  const excl = /\b(?:except(?:\s+on|\s+for)?|excluding|but not(?:\s+on)?|not on|skipping|skip)\b(.*)$/.exec(t);
  if (excl) {
    const parsed = parseExclusions(excl[1]);
    if ('error' in parsed) return parsed;
    exclusions = parsed;
    t = t.slice(0, excl.index).trim();
  }
  const withExclusions = (cron: string, description: string): CompiledSchedule => {
    const cronError = validateCron(cron);
    if (cronError) throw new Error(cronError);
    const result: CompiledSchedule = { cron, exclusions, description: description + describeExclusions(exclusions) };
    if (timezone) result.timezone = timezone;
    return result;
  };

  try {
    // Minute and hour intervals.
    if (/^(?:every|each) minute$/.test(t)) return withExclusions('* * * * *', 'Every minute');
    const minutes = /^(?:every|each)\s+(\w+)\s+(?:minutes?|mins?)$/.exec(t);
    if (minutes) {
      const n = parseCount(minutes[1]);
      if (!n || n < 1 || n > 59) return { error: 'Minute intervals must be between 1 and 59. For longer gaps use "every N hours".' };
      return withExclusions(`*/${n} * * * *`, `Every ${n} minute${n === 1 ? '' : 's'}`);
    }
    if (/^(?:hourly|every hour|each hour|once an hour|every 1 hours?)$/.test(t)) {
      return withExclusions('0 * * * *', 'Every hour, on the hour');
    }
    const hours = /^(?:every|each)\s+(\w+)\s+hours?$/.exec(t);
    if (hours) {
      const n = parseCount(hours[1]);
      if (!n || n < 1 || n > 23) return { error: 'Hour intervals must be between 1 and 23. For daily runs say "daily at 9".' };
      return withExclusions(`0 */${n} * * *`, `Every ${n} hours, on the hour`);
    }

    // Calendar schedules: a day spec plus times.
    const timeResult = extractTimes(t);
    if (timeResult && 'error' in timeResult) return timeResult;
    let times = timeResult?.times;
    if (times && new Set(times.map((x) => x.minute)).size > 1) {
      return { error: 'Multiple times in one schedule must share the same minute (e.g. "at 9 and 17"). Create two schedules otherwise.' };
    }
    const twice = /\btwice (?:a|per|each) day\b|\btwice daily\b/.test(t);
    let timeNote = '';
    if (!times) {
      times = twice ? [{ hour: 9, minute: 0 }, { hour: 17, minute: 0 }] : [{ hour: 9, minute: 0 }];
      timeNote = twice ? '' : ' (defaulting to 09:00)';
    }
    times = [...times].sort((a, b) => a.hour - b.hour);
    const hourField = [...new Set(times.map((x) => x.hour))].join(',');
    const minuteField = String(times[0].minute);
    const timeText = describeTime(times);

    if (/\bfirst day of (?:the |each |every )?month\b/.test(t) || /^monthly$/.test(t)) {
      return withExclusions(`${minuteField} ${hourField} 1 * *`, `At ${timeText} on the 1st of every month${timeNote}`);
    }
    if (/\blast day of (?:the |each |every )?month\b/.test(t)) {
      return withExclusions(`${minuteField} ${hourField} L * *`, `At ${timeText} on the last day of every month${timeNote}`);
    }
    const dom = /\b(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th) (?:of (?:the |each |every )?month|of every month)?/.exec(t);
    if (dom && /\bmonth|monthly\b/.test(t)) {
      const day = Number(dom[1]);
      if (day < 1 || day > 31) return { error: `Day of month ${day} is out of range (1-31).` };
      return withExclusions(`${minuteField} ${hourField} ${day} * *`, `At ${timeText} on day ${day} of every month${timeNote}`);
    }

    if (/\bweekends?\b/.test(t)) {
      return withExclusions(`${minuteField} ${hourField} * * 0,6`, `At ${timeText} on weekends${timeNote}`);
    }
    if (/\bweekdays?\b/.test(t)) {
      return withExclusions(`${minuteField} ${hourField} * * 1-5`, `At ${timeText} on weekdays${timeNote}`);
    }
    const days = parseDays(t);
    if (days.length > 0) {
      return withExclusions(
        `${minuteField} ${hourField} * * ${compressDays(days)}`,
        `At ${timeText} on ${describeDays(days)}${timeNote}`,
      );
    }
    if (/\b(?:daily|every day|each day|everyday|every night|every morning|twice a day|twice daily)\b/.test(t) || twice) {
      return withExclusions(`${minuteField} ${hourField} * * *`, `At ${timeText} every day${timeNote}`);
    }
    if (timeResult && /^(?:at\s+)?\S+$/.test(t)) {
      return withExclusions(`${minuteField} ${hourField} * * *`, `At ${timeText} every day`);
    }
    return { error: `Could not understand "${original.trim()}". ${EXAMPLES}` };
  } catch (error) {
    return { error: `Compiled an invalid schedule: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function zonedParts(date: Date, tz?: string): { weekday: number; ymd: string } {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return { weekday, ymd: `${parts.year}-${parts.month}-${parts.day}` };
}

/** True when `date` falls on an excluded weekday or date (evaluated in `tz`). */
export function isScheduleExcluded(exclusions: ScheduleExclusions | undefined, date: Date, tz?: string): boolean {
  if (!exclusions) return false;
  let parts: { weekday: number; ymd: string };
  try {
    parts = zonedParts(date, tz);
  } catch {
    parts = zonedParts(date);
  }
  if (exclusions.weekdays?.includes(parts.weekday)) return true;
  if (exclusions.dates?.includes(parts.ymd)) return true;
  return false;
}
