/** Pre-replay ring buffer (100 entries) + breadcrumbs (last 30). PRD §4.4 step 1, §4.11. */
import type { Breadcrumb, RingEvent } from './types';
import { en, now } from './u';

let R: RingEvent[] = [];
let sink: ((e: RingEvent) => void) | null = null;
let fix: (e: RingEvent) => RingEvent = (e) => e;

/** records a custom event: into the replay sink once running, else into the 100-entry ring */
export const rec = (type: RingEvent['type'], data: RingEvent['data'], ts = now()) => {
  if (!en) return;
  const e = { type, ts, data };
  if (sink) sink(e);
  else if (R.push(e) > 100) R.shift();
};

/** drains the ring (oldest first), applying lazy per-entry fixes (e.g. WS frame redaction) */
export const drain = () => {
  const r = R;
  R = [];
  return r.map(fix);
};
export const setSink = (f: typeof sink) => {
  sink = f;
};
/** lazy transform applied when entries leave the ring (kept off the hot path) */
export const setFix = (f: typeof fix) => {
  fix = f;
};

export let crumbs: Breadcrumb[] = [];
export const crumb = (cat: Breadcrumb['cat'], msg: string, data?: Breadcrumb['data'], ts = now()) => {
  if (!en) return;
  if (crumbs.push(data ? { ts, cat, msg, data } : { ts, cat, msg }) > 30) crumbs.shift();
};
export const resetRing = () => {
  R = [];
  crumbs = [];
};
