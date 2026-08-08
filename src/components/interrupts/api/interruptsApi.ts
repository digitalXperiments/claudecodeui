import { authenticatedFetch } from '../../../utils/api';
import type { Interrupt } from '../types';

async function parse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || `Interrupt request failed (${response.status})`);
  return payload as T;
}

export const interruptsApi = {
  async list(): Promise<{ interrupts: Interrupt[]; count: number }> {
    const response = await authenticatedFetch('/api/interrupts?status=open&limit=100');
    const payload = await parse<{ interrupts?: Interrupt[]; count?: number }>(response);
    return { interrupts: payload.interrupts ?? [], count: payload.count ?? 0 };
  },
  async action(id: string, actionKey: string): Promise<void> {
    const response = await authenticatedFetch(`/api/interrupts/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionKey)}`, { method: 'POST' });
    await parse(response);
  },
  async snooze(id: string, minutes = 15): Promise<void> {
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const response = await authenticatedFetch(`/api/interrupts/${encodeURIComponent(id)}/snooze`, { method: 'POST', body: JSON.stringify({ until }) });
    await parse(response);
  },
};

