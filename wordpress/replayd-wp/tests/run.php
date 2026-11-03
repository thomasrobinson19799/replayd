<?php
// Unit tests for replayd-wp with minimal WordPress stubs: php tests/run.php (exit 1 on failure).
define('ABSPATH', __DIR__);
$GLOBALS['opts'] = [];
$GLOBALS['filters'] = [];
$GLOBALS['actions'] = [];
$GLOBALS['is_admin'] = false;
function add_filter($h, $f, $p = 10, $n = 1) { $GLOBALS['filters'][$h][] = [$f, $n]; }
function add_action($h, $f, $p = 10, $n = 1) { $GLOBALS['actions'][$h][] = $f; }
function apply_filters($h, ...$a) { foreach ($GLOBALS['filters'][$h] ?? [] as [$f, $n]) { $a[0] = $f(...array_slice($a, 0, $n)); } return $a[0]; }
function get_option($k, $d = false) { return $GLOBALS['opts'][$k] ?? $d; }
function is_admin() { return $GLOBALS['is_admin']; }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_url($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_url_raw($s) { return filter_var($s, FILTER_SANITIZE_URL); }
function sanitize_text_field($s) { return trim(strip_tags((string) $s)); }
function sanitize_key($s) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $s)); }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function add_settings_error(...$a) { $GLOBALS['settings_errors'][] = $a; }
function __($s) { return $s; }
$enqueued = [];
function wp_enqueue_script(...$a) { $GLOBALS['enqueued'][] = $a; }

require __DIR__ . '/../replayd-wp.php';

$fail = 0;
function ok($c, $m) { global $fail; echo ($c ? 'ok   ' : 'FAIL ') . $m . "\n"; if (!$c) $fail++; }

// inactive without a valid DSN
foreach ($GLOBALS['actions']['wp_enqueue_scripts'] as $f) $f();
ok(empty($GLOBALS['enqueued']), 'no script without a DSN');

$GLOBALS['opts']['replayd_wp'] = ['dsn' => 'https://pk_abc@replay.example.com/fxglory-site', 'release' => '2026.11.03', 'environment' => 'production'];
ok(replayd_wp_active(), 'active with a valid DSN');
foreach ($GLOBALS['actions']['wp_enqueue_scripts'] as $f) $f();
$e = $GLOBALS['enqueued'][0] ?? [];
ok(($e[0] ?? '') === 'replayd-js' && $e[1] === '/_rp/sdk/latest/replayd.min.js' && $e[4] === ['in_footer' => false, 'strategy' => 'defer'], 'enqueued in <head>, deferred, no deps');

$tag = apply_filters('script_loader_tag', '<script src="x"></script>', 'replayd-js', 'x');
ok($tag === '<script id="replayd-js" src="/_rp/sdk/latest/replayd.min.js" data-dsn="https://pk_abc@replay.example.com/fxglory-site" data-release="2026.11.03" data-environment="production" data-tunnel="/_rp" data-no-optimize="1" data-no-defer="1" data-cfasync="false" defer></script>' . "\n", "tag: $tag");
ok(apply_filters('script_loader_tag', '<script src="other"></script>', 'jquery', 'other') === '<script src="other"></script>', 'other tags untouched');
ok(strpos($tag, '<script') === 0 && substr_count($tag, '<script') === 1, 'no inline script');

// attribute escaping
$GLOBALS['opts']['replayd_wp']['release'] = '1.0"><script>alert(1)</script>';
ok(strpos(replayd_wp_tag(), '<script>alert') === false, 'release escaped');
$GLOBALS['opts']['replayd_wp']['release'] = '2026.11.03';

// WP Rocket (D-08): exclusions merged into the existing lists, regex-safe, idempotent
$d = apply_filters('rocket_delay_js_exclusions', ['jquery']);
ok($d === ['jquery', '/_rp/sdk/latest/replayd\.min\.js', '/_rp/sdk/', 'replayd-js'], 'delay js exclusions: ' . json_encode($d));
foreach ($d as $p) ok(@preg_match('#' . $p . '#i', '') !== false, "valid regex: $p");
$tagMatch = array_filter($d, fn ($p) => preg_match('#' . $p . '#i', $tag));
ok(count($tagMatch) >= 2, 'delay js patterns match our tag (WP Rocket matches the whole <script> tag)');
ok(!preg_match('#' . implode('|', array_slice($d, 1)) . '#i', '<script src="/wp-content/themes/x/app.js"></script>'), 'patterns do not match theme scripts');
ok(apply_filters('rocket_exclude_js', []) === ['/_rp/sdk/latest/replayd.min.js'], 'minify/combine exclusion');
ok(apply_filters('rocket_exclude_defer_js', null) === ['/_rp/sdk/latest/replayd\.min\.js', '/_rp/sdk/', 'replayd-js'], 'defer exclusion (null list ok)');
ok(apply_filters('rocket_minify_excluded_external_js', []) === [], 'no external host for a same-origin SDK');
$GLOBALS['opts']['replayd_wp']['sdk_url'] = 'https://cdn.example.com/rp/1.0.0/replayd.min.js';
ok(apply_filters('rocket_minify_excluded_external_js', ['a.com']) === ['a.com', 'cdn.example.com'], 'external SDK host excluded from minify');
ok(apply_filters('rocket_delay_js_exclusions', [])[0] === '/rp/1\.0\.0/replayd\.min\.js', 'custom SDK path excluded');

// sanitize
$s = replayd_wp_sanitize(['enabled' => '1', 'dsn' => ' not-a-dsn ', 'environment' => 'Staging Env', 'tunnel' => '_rp/', 'sdk_url' => '']);
ok($s['dsn'] === 'https://pk_abc@replay.example.com/fxglory-site' && !empty($GLOBALS['settings_errors']), 'invalid DSN rejected, previous kept');
ok($s['environment'] === 'stagingenv' && $s['tunnel'] === '/_rp' && $s['sdk_url'] === '/_rp/sdk/latest/replayd.min.js', 'fields sanitized');
ok(replayd_wp_sanitize(['tunnel' => '/'])['tunnel'] === '' && replayd_wp_sanitize([])['enabled'] === '0', 'empty tunnel = direct ingest; unchecked = disabled');

// disabled / admin
$GLOBALS['opts']['replayd_wp']['enabled'] = '0';
ok(!replayd_wp_active(), 'disabled');
$GLOBALS['opts']['replayd_wp']['enabled'] = '1';
$GLOBALS['is_admin'] = true;
ok(!replayd_wp_active(), 'not on wp-admin pages');

echo $fail ? "$fail failed\n" : "all passed\n";
exit($fail ? 1 : 0);
