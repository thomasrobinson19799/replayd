/** Console, history and click instrumentation (PRD §4.11). console.time/timeEnd are never patched. */
import type { ConsoleLevel } from './types';
import { O } from './config';
import { capture, desc, isErr, ser } from './errors';
import { crumb, rec } from './ring';
import { rUrl } from './redact';
import { W, after, on } from './u';

let busy = false;

export const consoleHooks = () => {
  for (const l of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleLevel[])
    after(W.console, l, (_r, a: IArguments) => {
      if (busy) return; // re-entrancy: beforeSend / app code logging from inside capture
      busy = true;
      try {
        const s: string[] = [];
        for (let i = 0; i < a.length && i < 5; i++) s.push(ser(a[i]));
        const m = s.join(' ');
        rec('console', { level: l, args: s });
        crumb('console', m, { level: l });
        if (O.errors.console.includes(l)) {
          const e = [...a].find(isErr);
          capture(l == 'error' ? 'error' : 'warning', 'console', e ? e.name || 'Error' : `console.${l}`, m, e?.stack);
        }
      } finally {
        busy = false;
      }
    });
};

let last = '';
const nav = () => {
  const u = rUrl(W.location.href);
  if (u != last) {
    crumb('nav', u, { from: last });
    rec('nav', { from: last, to: u });
    last = u;
  }
};

export const navHooks = () => {
  last = rUrl(W.location.href);
  after(W.history, 'pushState', nav);
  after(W.history, 'replaceState', nav);
  on(W, 'popstate', nav);
  on(W.document, 'click', (e: Event) => {
    const t = e.target as Element;
    if (t?.closest) crumb('click', desc(t.closest('button,a,input,select,textarea,label,[role=button]') ?? t));
  });
};
