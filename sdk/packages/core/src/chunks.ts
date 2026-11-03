/**
 * Lazy chunk loaders (ESM build: real code-split chunks next to index.js).
 * The IIFE build swaps this module for chunks-iife.ts (see build.json `iifeAliases`).
 */
export const loaders = {
  replay: () => import('./replay/index'),
  capacitor: () => import('./capacitor/index'),
};
