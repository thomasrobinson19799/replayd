/**
 * Worker build stand-in for `../config` (build.json alias): redact.ts reads its lists from `O.redact`.
 * The main thread sends the resolved lists (defaults + user + remote extensions) with every segment cut.
 */
import type { RedactOptions } from '../types';

export const O = { redact: { headers: [], bodyKeys: [], queryParams: [] } as Required<RedactOptions> };
let v = 0;
export const redactVer = () => v;
/** replaces the lists when they changed (they only ever grow, so comparing lengths is enough) */
export const setRedact = (r: Required<RedactOptions>) => {
  const d = O.redact;
  if (r.headers.length + r.bodyKeys.length + r.queryParams.length != d.headers.length + d.bodyKeys.length + d.queryParams.length) {
    O.redact = r;
    v++;
  }
};
