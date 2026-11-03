/**
 * Tiny IndexedDB outbox shared by the replay worker (store `q`: segments) and the Capacitor chunk (store `e`:
 * error-event bodies). PRD §4.9: cap 20 MB, max age 24 h, oldest first. Never imported by index.js.
 * Records: `{ t: enqueued ms, b: body bytes, k?: ingest kind }`, auto-increment keys (= insertion order).
 */
export interface Rec {
  t: number;
  b: Uint8Array;
  k?: string;
}
export const CAP = 20 << 20, AGE = 864e5;
let db: Promise<IDBDatabase> | null = null;
const open = () =>
  (db ??= new Promise<IDBDatabase>((ok, no) => {
    const r = indexedDB.open('replayd', 1);
    r.onupgradeneeded = () => {
      for (const s of ['q', 'e']) r.result.createObjectStore(s, { autoIncrement: true });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  })).catch((e) => {
    db = null;
    throw e;
  });

const run = <T>(st: string, rw: boolean, f: (s: IDBObjectStore) => IDBRequest<T> | void) =>
  open().then(
    (d) =>
      new Promise<T | undefined>((ok, no) => {
        const t = d.transaction(st, rw ? 'readwrite' : 'readonly'), r = f(t.objectStore(st));
        t.oncomplete = () => ok(r ? r.result : undefined);
        t.onerror = t.onabort = () => no(t.error);
      }),
  );

/** appends a record; resolves to its key */
export const put = (st: string, v: Rec) => run<IDBValidKey>(st, true, (s) => s.add(v));
export const del = (st: string, k: IDBValidKey) => run(st, true, (s) => void s.delete(k));

/**
 * All records oldest first, after dropping the expired (> 24 h) and the oldest beyond 20 MB.
 * Resolves to `[kept: [key, rec][], dropped count]`.
 */
export const load = (st: string): Promise<[[IDBValidKey, Rec][], number]> => {
  const out: [IDBValidKey, Rec][] = [], all: [IDBValidKey, Rec][] = [];
  let n = 0, size = 0;
  return run(st, true, (s) => {
    const now = Date.now(), c = s.openCursor();
    c.onsuccess = () => {
      const x = c.result;
      if (x) {
        all.push([x.primaryKey, x.value as Rec]);
        x.continue();
        return;
      }
      // newest first for the size cap, then back to oldest-first order
      for (let i = all.length - 1; i >= 0; i--) {
        const [k, v] = all[i]!;
        if (now - v.t > AGE || (size += v.b.byteLength) > CAP) {
          s.delete(k);
          n++;
        } else out.unshift([k, v]);
      }
    };
  }).then(() => [out, n]);
};
