<?php
// T-04 harness: runs WP Rocket's real DelayJS\HTML::delay_js() + Subscriber::add_delay_js_script() logic on a page.
// Usage: php delayjs-harness.php <wp-rocket-dir> <in.html> [extra exclusion pattern ...]
declare(strict_types=1);

namespace WP_Rocket\Admin { class Options_Data { public function __construct(private array $o) {} public function get($k, $d = null) { return $this->o[$k] ?? $d; } } }
namespace WP_Rocket\Engine\Optimization\DynamicLists\DefaultLists { class DataManager { public function __construct(private object $l) {} public function get_lists() { return $this->l; } } }
namespace WP_Rocket\Logger { class Logger { public function debug($m) {} } }
namespace {
  $GLOBALS['__filters'] = [];
  function add_filter($name, $cb) { $GLOBALS['__filters'][$name][] = $cb; }
  function wpm_apply_filters_typed($type, $name, $value) { foreach ($GLOBALS['__filters'][$name] ?? [] as $cb) { $value = $cb($value); } return $value; }
  function wpm_apply_filters_typesafe($name, $value) { return wpm_apply_filters_typed('', $name, $value); }
  function rocket_bypass() { return false; }
  function rocket_get_constant($c) { return false; }
  function is_rocket_post_excluded_option($o) { return false; }

  [$_, $wpr, $in] = $argv;
  $extra = array_slice($argv, 3);
  require "$wpr/inc/Engine/Optimization/RegexTrait.php";
  require "$wpr/inc/Engine/Support/CommentTrait.php";
  require "$wpr/inc/Engine/Optimization/DelayJS/HTML.php";

  // what replayd-wp will do (T-41):
  if ($extra) { add_filter('rocket_delay_js_exclusions', fn($e) => array_merge($e, $extra)); }

  $lists = json_decode(file_get_contents("$wpr/dynamic-lists.json")); // WP Rocket's shipped default lists
  $html_engine = new \WP_Rocket\Engine\Optimization\DelayJS\HTML(
    new \WP_Rocket\Admin\Options_Data(['delay_js' => 1, 'delay_js_exclusions' => [], 'delay_js_execution_safe_mode' => 0]),
    new \WP_Rocket\Engine\Optimization\DynamicLists\DefaultLists\DataManager($lists),
    new \WP_Rocket\Logger\Logger()
  );
  $html = $html_engine->delay_js(file_get_contents($in));
  // Subscriber::add_delay_js_script()
  $lazy = file_get_contents("$wpr/assets/js/lazyload-scripts.min.js");
  $html = preg_replace('/<head[^>]*>/i', "$0<script>{$lazy}</script>", $html, 1);
  $html = preg_replace('/<head[^>]*>/i', '$0<script>' . $html_engine->get_ie_fallback() . '</script>', $html, 1);
  echo $html_engine->move_meta_charset_to_head($html);
}
