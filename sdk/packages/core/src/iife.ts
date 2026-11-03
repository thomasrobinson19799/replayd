/**
 * IIFE entry: `window.Replayd` for WordPress / plain HTML (data-attribute auto-init: T-40).
 * Assigned by hand rather than via esbuild `globalName`, whose CommonJS-style export helpers cost ~0.2 KB gz.
 */
import { addBreadcrumb, captureException, captureMessage, close, flush, init, setContext, setTag, setTags, setUser, SDK_VERSION } from './index';

(globalThis as { Replayd?: unknown }).Replayd = {
  init,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setTags,
  setContext,
  addBreadcrumb,
  flush,
  close,
  SDK_VERSION,
};
