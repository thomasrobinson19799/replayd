/**
 * fetch + XHR capture, exactly per docs/spikes/T-03.md (D-07): fetch wrapped outermost (after the
 * Capacitor bridge); XHR via prototype patch, or — when the CapacitorHttp bridge is active, because it
 * re-assigns prototype methods on every construction — a constructor wrapper with per-instance
 * own-property open/setRequestHeader/send. The SDK's own ingest URLs are never recorded.
 */
import { O, absu, own } from './config';
import { capture } from './errors';
import { crumb, rec } from './ring';
import { rHeaders, rText, rUrl } from './redact';
import { W, after, ctor, err, match, now, pnow, since, wrapf } from './u';

type X = Record<string, unknown>;

const failed = (s: number) =>
  O.errors.failedRequestStatusCodes.some((c) => (typeof c == 'number' ? s == c : s >= c[0] && s <= c[1]));

/** headers + bodies only for networkDetailAllowUrls (`'self'` = location.origin) */
const detail = (u: string) => {
  const o = W.location.origin;
  return match(
    O.replay.networkDetailAllowUrls.map((m) => (m == 'self' ? o + '/' : m)),
    u,
  );
};
const textual = (ct: string | null) => /json|text|xml|urlencoded/i.test(ct ?? '') && !/event-stream/i.test(ct!);

/** records a finished request: `network` ring/replay event, breadcrumb, failed-status error event */
const net = (m: string, url: string, status: number, ts: number, ms: number, x: X = {}) => {
  const u = rUrl(url);
  rec('network', { method: m, url: u, status, start: ts, duration: ms, ...x }, ts);
  crumb('http', `${m} ${u} ${status}`, { status });
  if (failed(status))
    capture('error', 'http', 'HTTPError', `${m} ${u.split('?')[0]} ${status}`, undefined, { http: { method: m, url: u, status, ms } }, url);
};

/** request side: size always; headers/body for allowlisted URLs (strings only, 10 KB, redacted) */
const req = (x: X, u: string, b: unknown, h: () => Iterable<[string, string]>) => {
  if (typeof b == 'string') x.reqSize = b.length;
  if (!detail(u)) return false;
  x.reqHeaders = rHeaders(h());
  if (O.replay.networkCaptureBodies !== false && typeof b == 'string') x.reqBody = rText(b.slice(0, 1e4));
  return O.replay.networkCaptureBodies !== false;
};

/** reads at most `cap` chars of a (cloned) body, then cancels — handles unknown-length bodies */
const read = async (r: Response, cap: number) => {
  const rd = r.body!.getReader(), d = new TextDecoder();
  let s = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) return s;
    if ((s += d.decode(value, { stream: true })).length > cap) return rd.cancel().catch(err), s.slice(0, cap);
  }
};

const fetched = (m: string, u: string, r: Response, ts: number, t0: number, n: RequestInit | undefined, rq: Request | 0) => {
  const ms = since(t0), x: X = {}, h = r.headers, cl = h.get('content-length');
  if (cl) x.resSize = +cl;
  if (req(x, u, n?.body, () => new Headers(n?.headers ?? (rq ? rq.headers : undefined)) as never)) {
    x.resHeaders = rHeaders(h as never);
    // clone now (before the app consumes the body), read async after the app got the response
    if (textual(h.get('content-type')) && !(+cl! > 5e4) && r.body) {
      const c = r.clone();
      return void read(c, 5e4)
        .then((s) => ((x.resBody = rText(s)), 0), err)
        .finally(() => net(m, u, r.status, ts, ms, x));
    }
  }
  net(m, u, r.status, ts, ms, x);
};

const K = Symbol();
interface XR {
  m: string;
  u: string;
  h: [string, string][];
  b?: unknown;
  t: number;
  ts: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XHR = XMLHttpRequest & { [K]?: XR } & Record<string, any>;

const xdone = (x: XHR) => {
  const r = x[K]!;
  if (own(r.u)) return;
  const ms = since(r.t), z: X = {}, cl = x.getResponseHeader('content-length');
  if (cl) z.resSize = +cl;
  if (req(z, r.u, r.b, () => r.h)) {
    z.resHeaders = rHeaders(x.getAllResponseHeaders().trim().split(/[\r\n]+/).map((l) => l.split(/: (.*)/)) as never);
    const t = x.responseType;
    if (textual(x.getResponseHeader('content-type')) && (!t || t == 'text' || t == 'json'))
      z.resBody = rText((t == 'json' ? JSON.stringify(x.response) : x.responseText).slice(0, 5e4));
  }
  net(r.m, r.u, x.status, r.ts, ms, z);
};
// open: start a record (t0 here so sync XHR works too), one loadend listener per instance
const xo = (_r: unknown, a: IArguments, x: XHR) => {
  const o = x[K];
  x[K] = { m: String(a[0]).toUpperCase(), u: absu(String(a[1])), h: [], t: pnow(), ts: now() };
  if (!o) x.addEventListener('loadend', () => x[K] && xdone(x));
};
const xh = (_r: unknown, a: IArguments, x: XHR) => x[K]?.h.push([a[0], a[1]]);
const xs = (_r: unknown, a: IArguments, x: XHR) => x[K] && (x[K].b = a[0]);

export const httpHooks = () => {
  after(W, 'fetch', (p: Promise<Response>, a: IArguments) => {
    const i = a[0], n: RequestInit | undefined = a[1], rq = i instanceof Request ? i : 0;
    const u = absu(rq ? rq.url : String(i)), ts = now(), t0 = pnow();
    const m = (n?.method || (rq && rq.method) || 'GET').toUpperCase();
    if (!own(u))
      p.then(
        (r) => fetched(m, u, r, ts, t0, n, rq),
        () => net(m, u, 0, ts, since(t0)),
      ).catch(err);
  });
  const B = W.CapacitorWebXMLHttpRequest;
  if (B && W.XMLHttpRequest !== B.fullObject)
    ctor('XMLHttpRequest', (x: XHR) => {
      const p = Object.getPrototypeOf(x);
      x.open = wrapf(p.open, xo);
      x.setRequestHeader = wrapf(p.setRequestHeader, xh);
      x.send = wrapf(p.send, xs);
    });
  else {
    const P = W.XMLHttpRequest?.prototype;
    after(P, 'open', xo);
    after(P, 'setRequestHeader', xh);
    after(P, 'send', xs);
  }
};
