// Windows verification uses installed Chrome when the Playwright CDN is unavailable.
import { chromium } from 'playwright';
const launch = chromium.launch.bind(chromium);
chromium.launch = options => launch({ channel: 'chrome', ...options });
