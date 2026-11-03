# Real-device APK checklist (T-51 / T-26 / T-03 residual risk)

The build sandbox has no Android device or emulator. Capacitor behaviour was verified with the real Capacitor 8.6
bridge emulated in Chromium (T-03) and a fake Capacitor runtime (T-26 `e2e/capacitor.e2e.mjs`). Run this list once
per terminal on the **reference device** (mid-range Android, Snapdragon 6xx class, Android System WebView 130+),
with a release APK built from the branch that carries `@replayd/nuxt`. Record results in `docs/bench.md` (T-51).

## Setup
- [ ] Project in replayd with allowed origin `https://localhost`; DSN in `runtimeConfig.public.replayd.dsn`
      (direct ingest host, HTTPS); release = `useAppConfig().app_version`.
- [ ] Source maps uploaded for the release (`npx @replayd/cli sourcemaps upload --url-prefix "~/_nuxt" --delete-after`).
- [ ] `chrome://inspect` → WebView devtools attached (USB debugging) for the timings below.

## Capture (CapacitorHttp **on** and **off** — two builds)
- [ ] App start: no change in first paint vs. the build without replayd (Performance panel, 3 cold starts).
- [ ] Error thrown in a component → issue visible in the dashboard < 5 s, platform `capacitor-android`, app version,
      device model, Android and WebView version filled; frames show original `src/…`/`.vue` lines (same maps as web).
- [ ] fetch **and** XHR calls (incl. a second XHR, T-03 clobbering case) appear in the replay Network tab with the
      original URL (not `/_capacitor_http_interceptor_`), status and timing; a 500 creates an `http` issue.
- [ ] Centrifugo: WS tab shows the connection, sampled frames by channel, outgoing connect with `token` =
      `[Filtered]`. Airplane mode → abnormal close (1006) → warning issue (1/min/session).
- [ ] Replay plays from the first frame; watchlist / order book update at ~1/s (`data-rp-throttle="1000"`),
      password field masked.

## Lifecycle + offline queue
- [ ] Home button (pause) → replay shows `app pause`; resume < 15 min → same session, `app resume` marker.
- [ ] Background > 15 min, resume → new session (sessions list), the previous one ends.
- [ ] Airplane mode for 2 min with activity + one error → back online: queued segments and the error arrive
      (oldest first), session has no gap; `chrome://inspect` → IndexedDB `replayd` stores `q`/`e` empty afterwards.
- [ ] Kill the app while offline, restart online → leftovers from the previous run are sent.
- [ ] Remote config: set `ws.maxFramesPerSec` 5 in the dashboard → after ≤ 10 min (or app restart after the TTL)
      the WS tab shows ≤ 5 frames/s.

## Performance (WebView devtools, release build)
- [ ] Main-thread time per 500 ms batch on the trading screen (Performance panel, 30 s): p95 ≤ the 4× desktop
      figure in docs/bench.md (D-20); record the number.
- [ ] Initial full snapshot task < 150 ms; no long task > 50 ms from the SDK afterwards.
- [ ] Uplink on the trading screen ≤ 5 KB/s average (dashboard session `bytes / duration`).
- [ ] Memory: JS heap after 30 min on the trading screen within +10 MB of the build without replayd.
- [ ] Battery/thermal: 30 min trading screen, no noticeable difference vs. the Sentry build (subjective + `adb shell
      dumpsys batterystats` if available).
