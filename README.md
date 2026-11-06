# replayd

Self-hosted frontend error tracking and session replay: Rust + PostgreSQL, a Nuxt dashboard,
and a small TypeScript SDK for browser, Vue, React, Nuxt, WordPress and Capacitor Android.

Capture errors and breadcrumbs, group and resolve issues, inspect source-mapped stacks,
and open the replay at the error. Recordings include network and sampled WebSocket
activity. Project roles control sensitive replay access. The dashboard includes user
administration, account passwords, capture settings and Telegram alert configuration.

Product scope and decisions: [PRD](PRD.md). Current implementation and owner-run acceptance:
[progress](PROGRESS.md). Canvas recording remains excluded from v1.

## Run locally

Install Docker, Node 22+ and pnpm 10.28.0. Rust is needed only for native server development;
the Docker image builds it internally. Build from the repository root:

```sh
docker build -t replayd:local server
docker build -f deploy/nginx/Dockerfile -t replayd-nginx:local .
docker compose -f deploy/docker-compose.yml --profile app up -d --wait
```

Open [the local dashboard](http://127.0.0.1:8088). The Compose defaults are for local
development only. Before a non-local installation, set a strong PostgreSQL password,
bootstrap email/password and `REPLAYD_PUBLIC_URL`, provide HTTPS termination, and configure
the real trusted proxy addresses. Do not expose the development credentials publicly.

On the Windows/Docker Desktop setup used in this repository,
`powershell -File scripts/local-stack.ps1` supplies the local proxy addresses and mock
Telegram endpoint. This helper is for local verification, not production configuration.

## Connect an application

Create a project in the dashboard. Its setup screen provides the DSN, a source-map upload
token shown once, and Nuxt, script-tag and CI snippets using the project's actual values.
Use `appConfig.app_version` for a Nuxt release. Configure allowed origins and add
`data-rp-throttle="1000"` to rapidly changing order books/watchlists.

- [Framework examples](examples/README.md)
- [Migration, source maps and site tunnels](docs/migration.md)
- [WordPress plugin source](wordpress/replayd-wp/replayd-wp.php)
- [Android acceptance checklist](docs/apk-checklist.md)
- [Bucket storage for finished replays](docs/object-storage.md)
- [MP4 exports, offline rendering and encoder licensing](docs/mp4-exports.md)
- [Ignore rules and dropped-event counters](docs/t-62-ignore-rules.md)
- [Copy stack contents and exclusions](docs/t-64-copy-stack.md)
- [Issue header actions](docs/t-65-issue-header.md)
- [Network filters](docs/t-66-network-filters.md)
- [Fullscreen behavior and verification](docs/t-67-fullscreen.md)

Build an installable WordPress plugin with `python scripts/package-wordpress.py`. The ZIP
is written to `data/releases/` and contains the plugin files without its tests. Upload it
through WordPress's plugin installer; configure its DSN and release in WordPress settings.

### Identity and custom fields

Sessions show the latest identity and custom fields; the replay Device tab preserves
timestamped changes and seeks when an entry is selected. Issues retain each event's values.

```ts
import { init, setUser, setCustomFields } from '@replayd/core'

init({ dsn: 'https://<publicKey>@replay.example.com/<project>', appVersion: '2.4.1' })
setUser({ id: 'customer-123', email: 'person@example.test', name: 'Jane' })
setCustomFields({ plan: 'pro', preferences: { language: 'en' } })
setCustomFields({ plan: null }) // remove a top-level key
setUser() // clear identity at logout
```

Custom fields are separate from tags. Updates merge top-level keys; null removes a key.
Values must be JSON, at most eight object/array levels and 16 KB total after recursive
key redaction. Invalid or oversized updates leave the prior snapshot intact. Script-tag
users call `Replayd.setUser`/`Replayd.setCustomFields`; auto-init accepts
`data-app-version`. Explicit app version takes precedence over Capacitor's detected version.

## Development checks

```sh
pnpm -C sdk install --frozen-lockfile
pnpm -C sdk lint
pnpm -C sdk test
pnpm -C sdk size
pnpm -C dashboard install --frozen-lockfile
pnpm -C dashboard lint
pnpm -C dashboard typecheck
pnpm -C dashboard test
pnpm -C dashboard build
```

Server checks are `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and
`cargo test` from `server/`. Use `scripts/check-server.ps1` on Windows to include the
database-backed tests against the local test stack.

The local integration runner is `node e2e/run-local.mjs` after installing `e2e/` dependencies
and building/starting the local images. It uses installed Chrome on this Windows setup.
Results are recorded in `docs/e2e-results.json`. WordPress compatibility can additionally
use actual WP Rocket source supplied through `WPROCKET_DIR`.

## Performance and operations

`pnpm -C sdk bench` runs cold initialization, WebSocket overhead, replay capture, and the
Sentry comparison. Install the benchmark browser with
`pnpm -C sdk --filter @replayd/bench exec playwright install chromium`, or select installed
Chrome with `PLAYWRIGHT_CHANNEL=chrome`. Logs and a structured report go to
`sdk/bench/results/`; failures produce a nonzero exit. Windows callers can use
`scripts/bench-local.ps1`. Missing timing evidence is a failure, not a passing sample.

See [measurements and limits](docs/bench.md), [backup and restore](deploy/backup/README.md),
and [Prometheus/Grafana setup](deploy/observability/README.md). Backups are opt-in via the
Compose `backup` profile; no production service is enabled by the development checks.

GitHub and GitLab CI run the unit/build checks and backup/WordPress verification. Scheduled
benchmarks retain their reports even when a budget fails. Live staging, physical Android,
site-specific installation and rollout acceptance are owned by the project owner.
