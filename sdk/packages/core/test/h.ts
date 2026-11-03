/** Test helpers: fresh SDK module graph per test, fetch mocks, gzip decode. */
import { vi } from 'vitest';
import type * as C from '../src/index';

export const DSN = 'https://pk123@replay.example.com/fxglory-terminal';
export type Core = typeof C;

/** fresh module state (patches from a previous init must be undone with close() first) */
export async function load(): Promise<Core> {
  vi.resetModules();
  return import('../src/index');
}

export const res = (status: number, headers: Record<string, string> = {}, body = '') =>
  new Response(status === 204 ? null : body, { status, headers });

/** installs a fetch mock on window; returns it */
export function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> = () => Promise.resolve(res(202))) {
  const f = vi.fn(impl);
  (globalThis as { fetch: unknown }).fetch = f;
  return f;
}

export async function gunzip(b: unknown): Promise<string> {
  const u8 = b instanceof ArrayBuffer ? new Uint8Array(b) : (b as Uint8Array);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return new TextDecoder().decode(u8);
  const s = new Blob([u8 as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

/** empties the outbox stores (deleteDatabase would block on connections of earlier module instances) */
export const clearDb = () =>
  new Promise<void>((ok) => {
    const r = indexedDB.open('replayd', 1);
    r.onupgradeneeded = () => {
      for (const s of ['q', 'e']) r.result.createObjectStore(s, { autoIncrement: true });
    };
    r.onsuccess = () => {
      const t = r.result.transaction(['q', 'e'], 'readwrite');
      t.objectStore('q').clear();
      t.objectStore('e').clear();
      t.oncomplete = () => {
        r.result.close();
        ok();
      };
    };
  });
