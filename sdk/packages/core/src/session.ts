/** Session manager, PRD §4.5. sessionStorage on web, localStorage under Capacitor. */
import type { Session } from './types';
import { now, sget, sset, uuid7 } from './u';

const KEY = 'rp_s', IDLE = 9e5, MAX = 36e5;
/** undefined = not loaded yet: the first storage access (~0.3–0.8 ms cold) is kept off the init() path */
let S: Session | null | undefined, L: 0 | 1 = 0, lw = 0;
let onNew: () => void = () => {};

/** selects the store (Capacitor → localStorage); `f` runs on every rollover. Loading is lazy (sess()). */
export const sInit = (cap: boolean, f: () => void) => {
  L = cap ? 1 : 0;
  onNew = f;
  S = undefined;
};

const save = () => {
  lw = now();
  sset(L, KEY, S);
};

/** current session; starts a new one if missing, idle > 15 min or older than 60 min */
export const sess = (t = now()): Session => {
  const first = S === undefined;
  if (first) S = sget(L, KEY);
  // written so NaN (corrupt storage) also rolls over
  if (!(S?.id && t - S.la <= IDLE && t - S.st <= MAX)) {
    S = { id: uuid7(), seq: 0, st: t, la: t };
    save();
    // in-page rollover only: on the first load, what was buffered so far belongs to this session
    if (!first) onNew();
  }
  return S;
};

/** user activity: cheap, storage written at most every 5 s (and on page hide) */
export const act = () => {
  const t = now();
  sess(t).la = t;
  if (t - lw > 5e3) save();
};

export const sSave = () => S && save();

export const nextSeq = () => {
  const s = sess();
  const n = s.seq++;
  save();
  return n;
};

/** replay sampling, decided once per session and stored with it */
export const sampled = (rate: number) => {
  const s = sess();
  if (s.smp == null) {
    s.smp = Math.random() < rate ? 1 : 0;
    save();
  }
  return s.smp == 1;
};
