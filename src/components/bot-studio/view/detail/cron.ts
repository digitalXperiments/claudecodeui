export type CronPreset = {
  id: string;
  label: string;
  cron: string | null;
  description: string;
};

export const CRON_PRESETS: CronPreset[] = [
  { id: '15m', label: 'Every 15 min', cron: '*/15 * * * *', description: 'Every fifteen minutes' },
  { id: '30m', label: 'Every 30 min', cron: '*/30 * * * *', description: 'Every thirty minutes' },
  { id: 'hourly', label: 'Hourly', cron: '0 * * * *', description: 'At the top of every hour' },
  { id: 'workdays', label: 'Workdays 09–19', cron: '0 9-19 * * 1-5', description: 'Every hour, Monday through Friday, 09:00–19:00' },
  { id: 'daily', label: 'Daily 09:00', cron: '0 9 * * *', description: 'Every day at 09:00' },
  { id: 'weekly', label: 'Weekly Mon 10:00', cron: '0 10 * * 1', description: 'Every Monday at 10:00' },
  { id: 'manual', label: 'Manual only', cron: null, description: 'Only when Run now is pressed' },
];

const FIELD_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export function validateCron(value: string): string | null {
  const cron = value.trim();
  if (!cron) return null;
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) return 'Use five cron fields: minute hour day-of-month month day-of-week.';
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!/^[0-9*/,\-?LW#]+$/.test(field)) return `Cron field ${index + 1} contains unsupported characters.`;
    const numbers = field.match(/\d+/g) ?? [];
    const [minimum, maximum] = FIELD_RANGES[index];
    if (numbers.some((number) => Number(number) < minimum || Number(number) > maximum)) {
      return `Cron field ${index + 1} must be between ${minimum} and ${maximum}.`;
    }
  }
  return null;
}

export function presetForCron(cron: string | null | undefined): CronPreset | undefined {
  return CRON_PRESETS.find((preset) => preset.cron === (cron?.trim() || null));
}

export function cronSummary(cron: string | null | undefined): string {
  const value = cron?.trim() ?? '';
  if (!value) return 'Manual only · Run now starts a tick.';
  const preset = presetForCron(value);
  return preset ? preset.description : `Custom schedule · ${value}`;
}
