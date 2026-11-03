/**
 * Redaction (PRD §0.2, §4.11): headers stripped, query params + JSON keys replaced by `[Filtered]`,
 * recursive to depth 8, case-insensitive. Pure functions over `O.redact` — reusable by the worker (T-20).
 */
import { O, redactVer } from './config';

export const FILTERED = '[Filtered]';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let v = -1, qre: RegExp, kre: RegExp;
const re = () => {
  if (v == redactVer()) return;
  v = redactVer();
  const k = O.redact.bodyKeys.map(esc).join('|');
  // URL params: query-param list + body keys (e.g. `#access_token=` in OAuth redirects)
  qre = new RegExp(`([?&#;](?:${O.redact.queryParams.map(esc).join('|')}|${k})=)[^&#;]*`, 'gi');
  // fallback for non-JSON / truncated text: `"key": value` and form fields `key=value`
  kre = new RegExp(`("(?:${k})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"?|[^,}\\]\\s]+)|((?:^|&)(?:${k})=)[^&\\s]*`, 'gi');
};

/** redacts secret query params (and fragment params) of a URL string */
export const rUrl = (u: string) => (re(), u.replace(qre, `$1${FILTERED}`));

/** copies headers into a lower-cased plain object, dropping the header denylist */
export const rHeaders = (h: Iterable<[string, string]>) => {
  const o: Record<string, string> = {};
  for (const [k, x] of h) {
    const l = k.toLowerCase();
    if (!O.redact.headers.includes(l)) o[l] = x;
  }
  return o;
};

/** recursive key redaction; subtrees deeper than 8 levels are dropped (never leaked unredacted) */
export const rJson = (x: unknown, d = 0): unknown => {
  if (!x || typeof x != 'object') return x;
  if (d > 7) return '[Depth]';
  if (Array.isArray(x)) return x.map((y) => rJson(y, d + 1));
  const o: Record<string, unknown> = {};
  for (const k in x) o[k] = O.redact.bodyKeys.includes(k.toLowerCase()) ? FILTERED : rJson((x as Record<string, unknown>)[k], d + 1);
  return o;
};

/**
 * Redacts a text body / WS frame. JSON (≤ 100 KB) is parsed and redacted structurally; newline-batched
 * JSON (Centrifugo) line by line; anything else (truncated frames, form bodies) by regex.
 */
export const rText = (s: string): string => {
  re();
  const c = s.trimStart()[0];
  if ((c == '{' || c == '[') && s.length < 1e5)
    try {
      return JSON.stringify(rJson(JSON.parse(s)));
    } catch {
      /* not (complete) JSON */
    }
  if (s.includes('\n')) return s.split('\n').map(rText).join('\n');
  return s.replace(kre, (_m, a, _x, f) => (a ? `${a}"${FILTERED}"` : f + FILTERED));
};
