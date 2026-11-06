/**
 * IIFE entry: `window.Replayd` for WordPress / plain HTML. Auto-init from the script tag's data attributes
 * (D-08: `<script src=…/replayd.min.js data-dsn data-release data-environment data-tunnel defer>`, no inline script).
 * Assigned by hand rather than via esbuild `globalName`, whose CommonJS-style export helpers cost ~0.2 KB gz.
 */
import { addBreadcrumb, captureException, captureMessage, close, flush, init, setContext, setCustomFields, setTag, setTags, setUser, SDK_VERSION } from './index';

(globalThis as { Replayd?: unknown }).Replayd = {
  init,
  captureException,
  captureMessage,
  setUser,
  setCustomFields,
  setTag,
  setTags,
  setContext,
  addBreadcrumb,
  flush,
  close,
  SDK_VERSION,
};

// auto-init (currentScript is set for classic, async and deferred scripts)
const d = (document.currentScript as HTMLScriptElement | null)?.dataset;
if (d?.dsn) init({ dsn: d.dsn, release: d.release, appVersion: d.appVersion, environment: d.environment, tunnel: d.tunnel });
