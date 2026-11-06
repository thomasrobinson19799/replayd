/** Public + internal types of @replayd/core (type-only module, emits no code). */

/** String = substring match (`'self'` = `location.origin` where documented), RegExp = test. */
export type Matcher = string | RegExp;
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface CanvasOptions {
  enabled?: boolean;
  fps?: number;
  maxWidth?: number;
  quality?: number;
  selector?: string;
  groupBy?: string;
}

export interface ReplayOptions {
  /** Per-session replay sample rate, decided once per session. Default 1. */
  sampleRate?: number;
  start?: 'idle';
  /** URLs whose request/response headers + bodies are captured. `'self'` = `location.origin`. */
  networkDetailAllowUrls?: Matcher[];
  networkCaptureBodies?: boolean;
  maskAllText?: boolean;
  maskAllInputs?: boolean;
  blockSelector?: string;
  maskSelector?: string;
  /** Out of scope for v1 (Decisions log D-01); accepted and ignored. */
  canvas?: CanvasOptions;
}

export interface WebSocketOptions {
  enabled?: boolean;
  urls?: Matcher[];
  sample?: { perChannelPerSec?: number; maxFramesPerSec?: number; maxFrameBytes?: number; outgoing?: 'all' | 'none' };
  channelOf?: 'centrifugo-json' | ((raw: string) => string | null);
}

export interface ErrorOptions {
  sampleRate?: number;
  console?: ConsoleLevel[];
  failedRequestStatusCodes?: (number | [number, number])[];
  ignoreErrors?: Matcher[];
  denyUrls?: Matcher[];
}

/** Redaction lists. They only ever EXTEND the built-in defaults (never replace them). */
export interface RedactOptions {
  headers?: string[];
  bodyKeys?: string[];
  queryParams?: string[];
}

export interface ReplaydOptions {
  /** `https://<publicKey>@<host>/<projectId|slug>` */
  dsn: string;
  /** Same-origin tunnel path, e.g. `/_rp`. Ignored under Capacitor. */
  tunnel?: string;
  release?: string;
  appVersion?: string;
  environment?: string;
  replay?: ReplayOptions;
  websocket?: WebSocketOptions;
  errors?: ErrorOptions;
  redact?: RedactOptions;
  beforeSend?: (event: ReplaydEvent) => ReplaydEvent | null | undefined | void;
  /** IndexedDB offline queue on web (always on under Capacitor; T-26). */
  offlineQueue?: boolean;
}

export interface Breadcrumb {
  ts: number;
  cat: 'click' | 'nav' | 'console' | 'http' | 'ws' | 'app' | 'custom' | (string & {});
  msg: string;
  data?: Record<string, unknown>;
}

export interface User {
  id?: string;
  email?: string;
  name?: string;
  [k: string]: unknown;
}

/** Error event, PRD §4.11. */
export interface ReplaydEvent {
  id: string;
  ts: number;
  sid: string;
  level: 'error' | 'warning';
  source: 'onerror' | 'unhandledrejection' | 'console' | 'http' | 'ws' | 'vue' | 'react' | 'manual';
  type: string;
  message: string;
  stack?: string;
  url: string;
  release?: string;
  env?: string;
  platform: 'web' | 'capacitor-android';
  user?: User;
  app_version?: string;
  timezone?: string;
  local_time?: string;
  custom_fields?: Record<string, unknown>;
  tags?: Record<string, string>;
  ctx?: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  count: number;
}

/** Ring-buffer / replay custom event (rrweb custom event tag + payload + original timestamp). */
export interface RingEvent {
  type: 'console' | 'network' | 'ws' | 'nav' | 'breadcrumb' | 'error' | 'app' | 'gap' | 'fields';
  ts: number;
  data: Record<string, unknown>;
}

export interface Session {
  /** session id (UUIDv7) */
  id: string;
  /** next replay segment seq */
  seq: number;
  /** startedAt (ms) */
  st: number;
  /** lastActivity (ms) */
  la: number;
  /** replay sampling decision, made once per session */
  smp?: 0 | 1;
}

/** Internal bridge handed to the lazy chunks (replay, capacitor). Not public API. */
export interface Internal {
  /** resolved options (local merged with remote config) */
  o: () => Resolved;
  /** current session (rolls over when expired) */
  sess: () => Session;
  /** returns the next segment seq for the current session */
  seq: () => number;
  /** drains the pre-replay ring buffer (lazy redaction applied) */
  drain: () => RingEvent[];
  /** live custom events go to `f` instead of the ring buffer (null = back to ring) */
  sink: (f: ((e: RingEvent) => void) | null) => void;
  /** registers the "force segment flush" hook called on every captured error */
  onError: (f: () => void) => void;
  /** capture currently enabled (kill switch / X-Replayd-Disable / close) */
  en: () => boolean;
  /** ingest URL for a kind (`events`, `replay`, `config`) */
  url: (kind: string) => string;
  /** main-thread transport fetch (CapacitorWebFetch ?? original fetch) */
  fetch: typeof fetch;
  /** queue a body for upload with retry/backoff */
  send: (kind: string, body: Uint8Array | ArrayBuffer) => void;
  /** internal error counter */
  ie: () => number;
  /** session counters for segment meta */
  c: { ws_disc: number };
  /** user, tags and the shared error context (mutable: the Capacitor chunk adds `ctx.app` + tags) */
  m: () => { user?: User; tags: Record<string, string>; ctx: Record<string, unknown>; custom_fields?: Record<string, unknown>; fields_version?: number };
  clock?: (ts: number) => { timezone?: string; local_time: string };
  /** records a custom event (replay sink or ring) */
  r: (type: RingEvent['type'], data: RingEvent['data'], ts?: number) => void;
  /** adds a breadcrumb */
  b: (cat: Breadcrumb['cat'], msg: string, data?: Breadcrumb['data'], ts?: number) => void;
  /** flushes core now as on page hide (Capacitor `pause`) */
  h: () => void;
  /** handler for event bodies whose upload failed for network/server reasons (Capacitor IndexedDB queue) */
  q: (f: (kind: string, body: Uint8Array | ArrayBuffer) => void) => void;
  platform: 'web' | 'capacitor-android';
}

export interface Resolved extends ReplaydOptions {
  replay: ReplayOptions & { sampleRate: number; networkDetailAllowUrls: Matcher[] };
  /** `channelOf` (default 'centrifugo-json') and `sample.outgoing` (default 'all') are defaulted by their consumers */
  websocket: Required<Pick<WebSocketOptions, 'enabled' | 'urls'>> &
    WebSocketOptions & { sample: NonNullable<WebSocketOptions['sample']> & { perChannelPerSec: number; maxFramesPerSec: number; maxFrameBytes: number } };
  errors: Required<ErrorOptions>;
  redact: Required<RedactOptions>;
}
