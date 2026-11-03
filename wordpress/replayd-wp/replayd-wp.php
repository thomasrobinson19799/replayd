<?php
/**
 * Plugin Name:       replayd
 * Description:       Session replay and frontend error tracking with a self-hosted replayd server (PRD §4.13).
 * Version:           0.1.0
 * Requires at least: 6.3
 * Requires PHP:      8.0
 * License:           Proprietary (internal)
 * Text Domain:       replayd-wp
 *
 * Adds the replayd SDK as the first script in <head>: `<script src=".../replayd.min.js" data-dsn=… defer>`.
 * Config goes in data-* attributes (no inline script), and the tag is excluded from WP Rocket's "Delay JavaScript
 * execution", minify/combine and defer (D-08), so errors before the first interaction are not lost.
 */

if (!defined('ABSPATH')) {
	exit;
}

const REPLAYD_WP_VERSION = '0.1.0';
const REPLAYD_WP_OPTION = 'replayd_wp';
const REPLAYD_WP_HANDLE = 'replayd-js';

/** Settings with defaults. Marketing sites: canvas/WS capture stay off (remote config decides per project). */
function replayd_wp_options(): array {
	$o = get_option(REPLAYD_WP_OPTION, []);
	return array_merge([
		'enabled'     => '1',
		'dsn'         => '',
		'release'     => '',
		'environment' => 'production',
		'tunnel'      => '/_rp',
		// served by replayd through the site's /_rp/ tunnel (same origin, long cache, versioned path)
		'sdk_url'     => '/_rp/sdk/latest/replayd.min.js',
	], is_array($o) ? $o : []);
}

/** The DSN must look like https://<publicKey>@<host>/<project>. */
function replayd_wp_valid_dsn(string $dsn): bool {
	return (bool) preg_match('#^https?://[A-Za-z0-9_\-]+@[A-Za-z0-9.\-]+(:\d+)?/[A-Za-z0-9_\-]+$#', $dsn);
}

function replayd_wp_active(): bool {
	$o = replayd_wp_options();
	return $o['enabled'] === '1' && replayd_wp_valid_dsn($o['dsn']) && !is_admin();
}

/** Path part of the SDK URL, used for the WP Rocket exclusion patterns. */
function replayd_wp_sdk_path(): string {
	$p = wp_parse_url(replayd_wp_options()['sdk_url'], PHP_URL_PATH);
	return is_string($p) && $p !== '' ? $p : '/_rp/sdk/';
}

// ---------- front end: the script tag, first in <head> ----------

add_action('wp_enqueue_scripts', function () {
	if (!replayd_wp_active()) {
		return;
	}
	// no dependencies, in <head>, deferred (WordPress 6.3+ strategy). The data-* attributes are added below.
	wp_enqueue_script(REPLAYD_WP_HANDLE, replayd_wp_options()['sdk_url'], [], null, ['in_footer' => false, 'strategy' => 'defer']);
}, 1);

/** Prints our script before every other enqueued head script. */
add_action('wp_head', function () {
	if (wp_script_is(REPLAYD_WP_HANDLE, 'enqueued')) {
		wp_print_scripts([REPLAYD_WP_HANDLE]);
	}
}, 1);

add_filter('script_loader_tag', function (string $tag, string $handle): string {
	if ($handle !== REPLAYD_WP_HANDLE) {
		return $tag;
	}
	return replayd_wp_tag();
}, 10, 2);

/** The full tag (also used by tests). */
function replayd_wp_tag(): string {
	$o = replayd_wp_options();
	$attrs = [
		'id'               => REPLAYD_WP_HANDLE,
		'src'              => esc_url($o['sdk_url']),
		'data-dsn'         => esc_attr($o['dsn']),
		'data-release'     => esc_attr($o['release']),
		'data-environment' => esc_attr($o['environment']),
		'data-tunnel'      => esc_attr($o['tunnel']),
		// tell WP Rocket and similar optimizers not to touch it (in addition to the filters below)
		'data-no-optimize' => '1',
		'data-no-defer'    => '1',
		'data-cfasync'     => 'false',
	];
	$s = '<script';
	foreach ($attrs as $k => $v) {
		if ($v !== '') {
			$s .= ' ' . $k . '="' . $v . '"';
		}
	}
	return $s . " defer></script>\n";
}

// ---------- WP Rocket exclusions (D-08, verified against WP Rocket v3.24 in docs/spikes/T-04.md) ----------

/**
 * WP Rocket matches each pattern as a case-insensitive regex against the whole <script> tag, so keep patterns
 * regex-safe: the SDK path and the tag id.
 */
function replayd_wp_rocket_patterns(): array {
	return [preg_quote(replayd_wp_sdk_path(), '#'), '/_rp/sdk/', REPLAYD_WP_HANDLE];
}

$replayd_wp_add = function ($list) {
	$list = is_array($list) ? $list : [];
	foreach (replayd_wp_rocket_patterns() as $p) {
		if (!in_array($p, $list, true)) {
			$list[] = $p;
		}
	}
	return $list;
};
add_filter('rocket_delay_js_exclusions', $replayd_wp_add);
add_filter('rocket_exclude_js', function ($list) {
	// minify / combine: WP Rocket expects paths here
	$list = is_array($list) ? $list : [];
	$p = replayd_wp_sdk_path();
	if (!in_array($p, $list, true)) {
		$list[] = $p;
	}
	return $list;
});
add_filter('rocket_exclude_defer_js', $replayd_wp_add);
add_filter('rocket_minify_excluded_external_js', function ($list) {
	$list = is_array($list) ? $list : [];
	$host = wp_parse_url(replayd_wp_options()['sdk_url'], PHP_URL_HOST);
	if (is_string($host) && $host !== '' && !in_array($host, $list, true)) {
		$list[] = $host;
	}
	return $list;
});

// ---------- settings page (Settings → replayd) ----------

add_action('admin_init', function () {
	register_setting('replayd_wp', REPLAYD_WP_OPTION, [
		'type'              => 'array',
		'sanitize_callback' => 'replayd_wp_sanitize',
	]);
});

function replayd_wp_sanitize($in): array {
	$in = is_array($in) ? $in : [];
	$out = [
		'enabled'     => !empty($in['enabled']) ? '1' : '0',
		'dsn'         => trim(sanitize_text_field($in['dsn'] ?? '')),
		'release'     => sanitize_text_field($in['release'] ?? ''),
		'environment' => sanitize_key($in['environment'] ?? 'production'),
		'tunnel'      => '/' . trim(sanitize_text_field($in['tunnel'] ?? '/_rp'), '/'),
		'sdk_url'     => esc_url_raw($in['sdk_url'] ?? '') ?: '/_rp/sdk/latest/replayd.min.js',
	];
	if ($out['dsn'] !== '' && !replayd_wp_valid_dsn($out['dsn'])) {
		add_settings_error(REPLAYD_WP_OPTION, 'dsn', __('The DSN must look like https://<key>@<host>/<project>.', 'replayd-wp'));
		$out['dsn'] = replayd_wp_options()['dsn'];
	}
	if ($out['tunnel'] === '/') {
		$out['tunnel'] = '';
	}
	return $out;
}

add_action('admin_menu', function () {
	add_options_page('replayd', 'replayd', 'manage_options', 'replayd-wp', 'replayd_wp_page');
});

function replayd_wp_page(): void {
	if (!current_user_can('manage_options')) {
		return;
	}
	$o = replayd_wp_options();
	$f = function (string $k, string $label, string $help = '') use ($o) {
		printf(
			'<tr><th scope="row"><label for="rp-%1$s">%2$s</label></th><td><input class="regular-text" id="rp-%1$s" name="%3$s[%1$s]" value="%4$s">%5$s</td></tr>',
			esc_attr($k), esc_html($label), esc_attr(REPLAYD_WP_OPTION), esc_attr($o[$k]), $help !== '' ? '<p class="description">' . esc_html($help) . '</p>' : ''
		);
	};
	echo '<div class="wrap"><h1>replayd</h1><form method="post" action="options.php">';
	settings_fields('replayd_wp');
	echo '<table class="form-table">';
	printf(
		'<tr><th scope="row">%s</th><td><label><input type="checkbox" name="%s[enabled]" value="1" %s> %s</label></td></tr>',
		esc_html__('Enabled', 'replayd-wp'), esc_attr(REPLAYD_WP_OPTION), checked($o['enabled'], '1', false), esc_html__('Record sessions and errors', 'replayd-wp')
	);
	$f('dsn', 'DSN', 'From the replayd project (Settings → Keys & DSN).');
	$f('release', 'Release', 'Theme/site version, e.g. 2026.11.03.');
	$f('environment', 'Environment');
	$f('tunnel', 'Tunnel path', 'Same-origin path proxied by nginx to the replayd ingest (default /_rp).');
	$f('sdk_url', 'SDK URL', 'Default /_rp/sdk/latest/replayd.min.js (served by replayd through the tunnel).');
	echo '</table>';
	submit_button();
	echo '<p>' . esc_html__('The SDK tag is excluded from WP Rocket Delay JS, minify/combine and defer automatically.', 'replayd-wp') . '</p></form></div>';
}
