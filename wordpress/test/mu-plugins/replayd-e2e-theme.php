<?php
// e2e only: a theme-like script that throws on DOMContentLoaded (before any interaction) and a button that throws.
add_action('wp_footer', function () {
	echo "<script id=\"e2e-theme\">document.addEventListener('DOMContentLoaded', function () { window.themeInit.slider(); });</script>\n";
	echo '<button id="buy" onclick="null.price">Buy</button>';
}, 5);
