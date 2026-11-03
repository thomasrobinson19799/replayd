// T-03 prototype of the core SDK fetch/XHR instrumentation. window.__rpHttp.install(mode): 'planned' | 'naive'.
(() => {
  const log = [];
  const done = (e) => log.push(e);
  const now = () => performance.now();

  function patchFetch(win) {
    const orig = win.fetch; // bridge's fetch when CapacitorHttp is on: we are always the OUTER wrapper
    win.fetch = function (input, init) {
      const t0 = now();
      const req = input instanceof Request ? input : null;
      const method = ((init && init.method) || (req && req.method) || 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : req ? req.url : String(input);
      const p = orig.apply(this, arguments);
      p.then((res) => {
        const e = { via: 'fetch', method, url, status: res.status, ms: Math.round(now() - t0) };
        const ct = res.headers.get('content-type') || '';
        if (/json|text/.test(ct)) res.clone().text().then((b) => { e.body = b.slice(0, 200); done(e); }, () => done(e));
        else done(e);
      }, (err) => done({ via: 'fetch', method, url, status: 0, error: String(err) }));
      return p;
    };
  }

  function instrumentXhr(x, open, send) {
    let method = 'GET', url = '', t0 = 0;
    x.open = function (m, u) { method = String(m).toUpperCase(); url = String(u); return open.apply(this, arguments); };
    x.send = function () {
      t0 = now();
      x.addEventListener('loadend', () => done({ via: 'xhr', method, url, status: x.status, ms: Math.round(now() - t0), body: typeof x.responseText === 'string' ? x.responseText.slice(0, 200) : undefined }));
      return send.apply(this, arguments);
    };
  }

  function patchXhrPrototype(win) {
    const P = win.XMLHttpRequest.prototype; const open = P.open, send = P.send;
    P.open = function (m, u) { this.__rp = { method: String(m).toUpperCase(), url: String(u) }; return open.apply(this, arguments); };
    P.send = function () {
      const r = this.__rp || {}; const t0 = now();
      this.addEventListener('loadend', () => done({ via: 'xhr', method: r.method, url: r.url, status: this.status, ms: Math.round(now() - t0) }));
      return send.apply(this, arguments);
    };
  }

  function patchXhrConstructor(win) {
    const Bridge = win.XMLHttpRequest;
    function XMLHttpRequest() {
      const x = new Bridge(); // bridge ctor re-assigns open/send/... on the shared prototype here
      const proto = Object.getPrototypeOf(x);
      instrumentXhr(x, proto.open, proto.send); // own props shadow the prototype → survive later re-assignment
      return x;
    }
    XMLHttpRequest.prototype = Bridge.prototype;
    Object.assign(XMLHttpRequest, Bridge);
    win.XMLHttpRequest = XMLHttpRequest;
  }

  window.__rpHttp = {
    log,
    install(mode) {
      // our own transport must bypass CapacitorHttp (base64 over the bridge, no keepalive)
      window.__rpTransportFetch = window.CapacitorWebFetch || window.fetch;
      patchFetch(window);
      const bridged = !!window.CapacitorWebXMLHttpRequest && window.XMLHttpRequest !== window.CapacitorWebXMLHttpRequest.fullObject;
      if (mode === 'naive' || !bridged) patchXhrPrototype(window); else patchXhrConstructor(window);
      return { bridged };
    },
  };
})();
