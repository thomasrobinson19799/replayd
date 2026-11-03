/** @replayd/core — public API. Implemented in T-12…T-14. */
export const SDK_VERSION: string = __RP_VERSION__;

export interface ReplaydOptions {
  dsn: string;
  release?: string;
  environment?: string;
}

/** Initialise the SDK. Synchronous, never throws (T-12). */
export function init(_options: ReplaydOptions): void {}
