/** Identity/custom-field changes are infrequent call-time work, never mutation/WS work. */
import type { User } from './types';
import { rJson } from './redact';
import { rec } from './ring';

export let user: User | undefined;
export let customFields: Record<string, unknown> = {};
export let fieldsVersion = 0;

export function setUser(u?: User): void {
  try {
    user = u ? rJson(JSON.parse(JSON.stringify(u))) as User : undefined;
    fieldsVersion++;
    rec('fields', { field: 'user', value: user ?? null });
  } catch { /* invalid user input never escapes into the application */ }
}

export function setCustomFields(update: Record<string, unknown>): void {
  try {
    const next = { ...customFields };
    for (const k of Object.keys(update)) {
      if (update[k] === null) delete next[k];
      else Object.defineProperty(next, k, { value: update[k], enumerable: true, configurable: true, writable: true });
    }
    const seen = new Set<object>();
    const valid = (v: unknown, depth: number): boolean => {
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
      if (typeof v === 'number') return Number.isFinite(v);
      if (typeof v !== 'object' || depth > 7 || seen.has(v)) return false;
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
      seen.add(v);
      const ok = Object.values(v).every(x => valid(x, depth + 1));
      seen.delete(v);
      return ok;
    };
    if (!valid(next, 0)) return;
    const encoded = JSON.stringify(rJson(next));
    if (new TextEncoder().encode(encoded).length > 16 * 1024) return;
    customFields = JSON.parse(encoded);
    fieldsVersion++;
    rec('fields', { field: 'custom_fields', value: customFields });
  } catch { /* atomic: the previous snapshot is retained */ }
}

export function localClock(ts: number): { timezone?: string; local_time: string } {
  const d = new Date(ts), pad = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset(), minutes = Math.abs(offset);
  let timezone: string | undefined;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* old WebView */ }
  return {
    timezone,
    local_time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
  };
}
