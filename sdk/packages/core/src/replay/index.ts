/**
 * Lazy replay chunk: rrweb + worker bridge. Implemented in T-20.
 * Uses core only through `Internal` — a runtime import from a core module would make esbuild split a
 * shared chunk out of index.js.
 */
import type { Internal } from '../types';

export function startReplay(_i: Internal): void {}
