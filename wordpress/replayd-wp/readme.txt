=== replayd ===
Requires at least: 6.3
Requires PHP: 8.0
Stable tag: 0.1.0

Session replay and frontend error tracking with a self-hosted replayd server.

== Installation ==
1. Upload `replayd-wp` to `wp-content/plugins/` and activate it.
2. Settings → replayd: paste the project DSN, set the release.
3. nginx: proxy `/_rp/` of the site to the replayd ingest (`location /_rp/ { proxy_pass https://replay.example.com/ingest/; }`).

The SDK is printed as the first script in <head> with `defer` and its config in data-* attributes, and it is
excluded from WP Rocket "Delay JavaScript execution", minify/combine and defer (filters
`rocket_delay_js_exclusions`, `rocket_exclude_js`, `rocket_exclude_defer_js`, `rocket_minify_excluded_external_js`).
