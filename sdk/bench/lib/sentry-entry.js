// The terminals' current Sentry setup (PRD §4.3), bundled as one IIFE for the comparison bench (T-51).
import * as Sentry from '@sentry/browser';

globalThis.__sentryInit = (dsn) => Sentry.init({
  dsn,
  tunnel: '/sentry',
  release: 'bench',
  environment: 'bench',
  sampleRate: 1.0,
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  sendDefaultPii: false,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.captureConsoleIntegration({ levels: ['error', 'warn'] }),
    Sentry.httpClientIntegration({ failedRequestStatusCodes: [[400, 599]] }),
    Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false, networkDetailAllowUrls: [location.origin] }),
  ],
});
