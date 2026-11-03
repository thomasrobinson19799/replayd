/**
 * IIFE variant of chunks.ts: the lazy ESM chunks are loaded by URL from the directory of
 * replayd.min.js (served by replayd under /_rp/sdk/<version>/), so they are not inlined into the
 * synchronous script.
 */
import type * as R from './replay/index';
import type * as C from './capacitor/index';

const base = (document.currentScript as HTMLScriptElement | null)?.src || location.href;
const load = (f: string) => import(/* @vite-ignore */ new URL(f, base).href);

export const loaders = {
  replay: (): Promise<typeof R> => load('replay.js'),
  capacitor: (): Promise<typeof C> => load('capacitor.js'),
};
