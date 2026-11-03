//! URL normalization and in-app detection (§5.5 step 2–3).
//!
//! `https://localhost/_nuxt/x.js` (APK) and `https://terminal.fxglory.com/_nuxt/x.js` (web) both become
//! `~/_nuxt/x.js`, so the same uploaded source maps serve both, and issues group across platforms.

use crate::stack::Frame;

/// Strips scheme + host (+ port), query and fragment: `https://h:1/a/b.js?v=1#x` → `~/a/b.js`.
/// Non-http(s) URLs (`blob:`, `chrome-extension://`, …) are kept as-is.
pub fn tilde_path(url: &str) -> String {
    let rest = if let Some(r) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        r
    } else if let Some(r) = url.strip_prefix("capacitor://") {
        r
    } else if url.starts_with('/') {
        return format!("~{}", strip_query(url));
    } else {
        return url.to_string();
    };
    let path = rest.find('/').map(|i| &rest[i..]).unwrap_or("/");
    format!("~{}", strip_query(path))
}

fn strip_query(p: &str) -> &str {
    let end = p.find(['?', '#']).unwrap_or(p.len());
    &p[..end]
}

/// Host of an absolute http(s) URL, lower-cased, without port.
pub fn host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let hp = &rest[..end];
    let h = hp.rsplit_once(':').map(|(h, _)| h).unwrap_or(hp);
    Some(h.to_ascii_lowercase())
}

/// Paths of bundled third-party code that is never in-app (TradingView library, vendored deps).
const NOT_IN_APP: &[&str] = &[
    "/node_modules/",
    "/charting_library/",
    "/tradingview/",
    "/datafeeds/",
    "/vendor/",
    "/wp-includes/",
    "/wp-content/plugins/",
];

/// Fills `path` and `in_app` for each frame. A frame is in-app when it comes from the page's own host (or
/// `localhost`, i.e. the APK) and its path is not a known third-party location.
pub fn annotate(frames: &mut [Frame], page_url: Option<&str>) {
    let page_host = page_url.and_then(host);
    for f in frames.iter_mut() {
        if f.url.is_empty() {
            f.in_app = false;
            continue;
        }
        f.path = tilde_path(&f.url);
        let fh = host(&f.url);
        let same_host = match (&fh, &page_host) {
            (Some(a), Some(b)) => a == b || a == "localhost",
            (Some(a), None) => a == "localhost",
            (None, _) => f.url.starts_with('/'),
        };
        let third_party = NOT_IN_APP.iter().any(|p| f.path.contains(p))
            || f.url.starts_with("chrome-extension://")
            || f.url.starts_with("moz-extension://")
            || f.url.starts_with("safari-web-extension://");
        f.in_app = same_host && !third_party;
    }
}

/// Removes build-hash segments from file names so unsymbolicated frames group across releases:
/// `~/_nuxt/OrderPanel.Cx1aB2_9.js` → `~/_nuxt/OrderPanel.js`, `~/assets/index-4f9a1c2e.js` → `~/assets/index.js`.
pub fn strip_build_hash(path: &str) -> String {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let Some(dot) = file.rfind('.') else {
        return path.to_string();
    };
    let (stem, ext) = (&file[..dot], &file[dot..]);
    let looks_hash = |h: &str| {
        h.len() >= 6
            && h.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && h.chars().any(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
    };
    let cut = stem
        .rfind(['.', '-'])
        .filter(|&i| i > 0 && looks_hash(&stem[i + 1..]))
        .map(|i| &stem[..i]);
    match cut {
        Some(s) => format!("{dir}{s}{ext}"),
        None => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_paths() {
        assert_eq!(tilde_path("https://localhost/_nuxt/x.js"), "~/_nuxt/x.js");
        assert_eq!(
            tilde_path("https://terminal.fxglory.com/_nuxt/x.js?v=3#a"),
            "~/_nuxt/x.js"
        );
        assert_eq!(tilde_path("http://127.0.0.1:3000/a.js"), "~/a.js");
        assert_eq!(tilde_path("capacitor://localhost/_nuxt/x.js"), "~/_nuxt/x.js");
        assert_eq!(tilde_path("https://h.com"), "~/");
        assert_eq!(tilde_path("blob:https://x/1"), "blob:https://x/1");
        assert_eq!(
            host("https://Terminal.FXGlory.com:443/x"),
            Some("terminal.fxglory.com".into())
        );
    }

    #[test]
    fn in_app() {
        let mut fr = vec![
            Frame {
                url: "https://localhost/_nuxt/a.js".into(),
                ..Default::default()
            },
            Frame {
                url: "https://terminal.fxglory.com/_nuxt/a.js".into(),
                ..Default::default()
            },
            Frame {
                url: "https://terminal.fxglory.com/charting_library/bundles/x.js".into(),
                ..Default::default()
            },
            Frame {
                url: "https://www.googletagmanager.com/gtm.js".into(),
                ..Default::default()
            },
            Frame {
                url: "chrome-extension://abc/x.js".into(),
                ..Default::default()
            },
            Frame::default(),
        ];
        annotate(&mut fr, Some("https://terminal.fxglory.com/trade"));
        let flags: Vec<bool> = fr.iter().map(|f| f.in_app).collect();
        assert_eq!(flags, [true, true, false, false, false, false]);
        assert_eq!(fr[0].path, fr[1].path);
    }

    #[test]
    fn build_hashes() {
        assert_eq!(
            strip_build_hash("~/_nuxt/OrderPanel.Cx1aB2_9.js"),
            "~/_nuxt/OrderPanel.js"
        );
        assert_eq!(
            strip_build_hash("~/assets/index-4f9a1c2e.js"),
            "~/assets/index.js"
        );
        assert_eq!(strip_build_hash("~/_nuxt/entry.js"), "~/_nuxt/entry.js");
        assert_eq!(strip_build_hash("~/js/app.min.js"), "~/js/app.min.js");
        assert_eq!(strip_build_hash("~/order-panel.js"), "~/order-panel.js");
    }
}
