// Emulates the Android side of Capacitor 8 for CapacitorHttp: answers 'CapacitorHttp.request' by doing a real
// fetch with the untouched WebView fetch, like the native OkHttp path would. Runs before native-bridge.js.
(() => {
  const realFetch = window.fetch.bind(window);
  const enabled = new URLSearchParams(location.search).get('caphttp') === '1';
  window.WEBVIEW_SERVER_URL = 'https://localhost'; // as in the APK; the app's API host is a different origin
  window.CapacitorHttpAndroidInterface = { isEnabled: () => enabled };
  window.CapacitorCookiesAndroidInterface = { isEnabled: () => false };
  window.__nativeCalls = [];
  window.androidBridge = {
    postMessage(json) {
      const call = JSON.parse(json);
      if (call.pluginId !== 'CapacitorHttp') return;
      const o = call.options;
      window.__nativeCalls.push({ method: o.method, url: o.url, dataType: o.dataType });
      realFetch(o.url, { method: o.method, headers: o.headers, body: o.data && o.method !== 'GET' ? o.data : undefined })
        .then(async (r) => {
          const ct = r.headers.get('content-type') || '';
          const text = await r.text();
          const data = ct.startsWith('application/json') ? JSON.parse(text || 'null') : text;
          const headers = Object.fromEntries(r.headers.entries());
          // native plugin rejects for non-2xx? No: CapacitorHttp resolves with status for HTTP errors.
          window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: call.callbackId, pluginId: 'CapacitorHttp', methodName: 'request', success: true, data: { status: r.status, headers, data, url: r.url } }) });
        })
        .catch((e) => window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: call.callbackId, pluginId: 'CapacitorHttp', methodName: 'request', success: false, error: { message: String(e) } }) }));
    },
  };
})();
