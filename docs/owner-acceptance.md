# Owner-run live acceptance

The owner explicitly takes these checks under D-34. The repository implementation and
local verification are tracked separately in PROGRESS.md. An unchecked item here is not
a claim that it passed, nor a request for the coding agent to wait for access.

- [ ] Install the generated `data/releases/replayd-wp-0.1.0.zip` on WordPress staging,
  configure the real DSN/release and confirm errors before the first interaction plus
  a playable replay with the site's actual WP Rocket/cache/CDN configuration.
- [ ] Run [the Android checklist](apk-checklist.md) on the reference physical device,
  including CapacitorHttp on/off, offline restart recovery and the 30-minute heap/thermal run.
- [ ] Run the benchmark on the release setup and retain `sdk/bench/results/summary.json`.
  The local snapshot recheck passes at 144 ms / 4×; this is not a guarantee on another device.
- [ ] Apply the [migration instructions](migration.md) to the sites, check the terminals'
  source-map CI with real protected variables, and confirm original stack frames and
  live ingest. The shared terminal source migration has already been inventoried.
- [ ] Confirm HTTPS, allowed origins, trusted proxies, strong bootstrap/database credentials,
  and [backup/restore](../deploy/backup/README.md) in the intended environment.
- [ ] Complete rollout/cutover checks and remove remaining site-specific Sentry snippets or
  tunnels only after validating the replacement. Publish changed SDK assets under a new
  version when releasing; existing versioned SDK URLs are immutable.

No production changes, remote messages or pushes were performed by the coding agent.
