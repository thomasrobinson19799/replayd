//! Raw JS stack parsing for V8 (Chrome, Edge, Android WebView), SpiderMonkey (Firefox) and
//! JavaScriptCore (Safari). The SDK sends `error.stack` verbatim; all parsing happens here (§4.11).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Frame {
    /// Function name as reported (may be empty or minified).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub function: String,
    /// Absolute URL as reported by the engine (empty for native frames).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default)]
    pub line: u32,
    #[serde(default)]
    pub col: u32,
    /// `~/path` form of `url` (filled by normalization).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(default)]
    pub in_app: bool,
    /// Original location after source-map symbolication (T-30).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig: Option<OrigFrame>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct OrigFrame {
    pub file: String,
    pub line: u32,
    pub col: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub function: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pre: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub context: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub post: Vec<String>,
}

/// Max frames kept per stack (deep recursion stacks are truncated).
pub const MAX_FRAMES: usize = 64;

/// Splits `url:line:col` (or `url:line`) from the right. Returns `None` if no numeric line.
fn split_location(s: &str) -> Option<(&str, u32, u32)> {
    let s = s.trim();
    let (rest, last) = s.rsplit_once(':')?;
    let last_n: u32 = last.parse().ok()?;
    if let Some((url, line)) = rest.rsplit_once(':')
        && let Ok(line_n) = line.parse::<u32>()
    {
        return Some((url, line_n, last_n));
    }
    Some((rest, last_n, 0))
}

/// V8: `    at fn (url:1:2)`, `    at url:1:2`, `    at async fn (url:1:2)`,
/// `    at eval (eval at f (url:1:2), <anonymous>:1:1)`.
fn parse_v8(line: &str) -> Option<Frame> {
    let l = line.trim_start().strip_prefix("at ")?.trim();
    let l = l.strip_prefix("async ").unwrap_or(l);
    let (function, loc) = match l.strip_suffix(')') {
        Some(inner) => {
            let open = inner.find(" (")?;
            (&inner[..open], &inner[open + 2..])
        }
        None => ("", l),
    };
    // eval frames: use the outer "eval at f (url:l:c)" location
    let loc = if let Some(rest) = loc.strip_prefix("eval at ") {
        rest.split_once(" (")
            .map(|(_, r)| r.split_once(')').map(|(a, _)| a).unwrap_or(r))
            .unwrap_or(loc)
    } else {
        loc
    };
    if loc == "native" || loc == "<anonymous>" {
        return Some(Frame {
            function: function.into(),
            ..Default::default()
        });
    }
    let (url, line, col) = split_location(loc)?;
    Some(Frame {
        function: function.into(),
        url: url.into(),
        line,
        col,
        ..Default::default()
    })
}

/// SpiderMonkey / JSC: `fn@url:1:2`, `@url:1:2`, `global code@url:1:2`, JSC also `url:1:2` and
/// `[native code]`.
fn parse_at_style(line: &str) -> Option<Frame> {
    let l = line.trim();
    if l.is_empty() {
        return None;
    }
    if l == "[native code]" {
        return Some(Frame::default());
    }
    let (function, loc) = match l.rfind('@') {
        // an '@' inside the URL (rare) would come after "://"; frames put it before the URL
        Some(i) if !l[..i].contains("://") => (&l[..i], &l[i + 1..]),
        _ => ("", l),
    };
    if loc == "[native code]" {
        return Some(Frame {
            function: function.into(),
            ..Default::default()
        });
    }
    let (url, line, col) = split_location(loc)?;
    if !url.contains(':') && !url.starts_with('/') {
        return None; // not a location ("TypeError: x" header lines etc.)
    }
    Some(Frame {
        function: function.into(),
        url: url.into(),
        line,
        col,
        ..Default::default()
    })
}

/// Parses a raw stack string. Frames are ordered innermost first (as engines print them).
pub fn parse(stack: &str) -> Vec<Frame> {
    let is_v8 = stack.lines().any(|l| l.trim_start().starts_with("at "));
    let mut frames = Vec::new();
    for line in stack.lines() {
        if frames.len() >= MAX_FRAMES {
            break;
        }
        let f = if is_v8 {
            parse_v8(line)
        } else {
            parse_at_style(line)
        };
        if let Some(f) = f {
            frames.push(f);
        }
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(function: &str, url: &str, line: u32, col: u32) -> Frame {
        Frame {
            function: function.into(),
            url: url.into(),
            line,
            col,
            ..Default::default()
        }
    }

    #[test]
    fn v8_chrome_and_android_webview() {
        let s = "TypeError: Cannot read properties of undefined (reading 'price')\n    at OrderPanel.submit (https://terminal.fxglory.com/_nuxt/OrderPanel.Cx1aB2.js:1:2345)\n    at async Promise.all (index 0)\n    at https://localhost/_nuxt/entry.B2c3D4.js:3:999\n    at new Foo (https://x.com/a.js:10:5)\n    at Array.map (<anonymous>)\n    at eval (eval at run (https://x.com/b.js:4:6), <anonymous>:1:1)";
        let fr = parse(s);
        assert_eq!(
            fr[0],
            f(
                "OrderPanel.submit",
                "https://terminal.fxglory.com/_nuxt/OrderPanel.Cx1aB2.js",
                1,
                2345
            )
        );
        // "at async Promise.all (index 0)" has no location and is skipped
        assert_eq!(fr[1], f("", "https://localhost/_nuxt/entry.B2c3D4.js", 3, 999));
        assert_eq!(fr[2], f("new Foo", "https://x.com/a.js", 10, 5));
        assert_eq!(fr[3], f("Array.map", "", 0, 0));
        assert_eq!(fr[4], f("eval", "https://x.com/b.js", 4, 6));
        assert_eq!(fr.len(), 5);
    }

    #[test]
    fn spidermonkey_firefox() {
        let s = "submit@https://terminal.fxglory.com/_nuxt/OrderPanel.Cx1aB2.js:1:2345\nsetup/</<@https://terminal.fxglory.com/_nuxt/entry.js:3:999\n@https://terminal.fxglory.com/_nuxt/entry.js:5:1\n";
        let fr = parse(s);
        assert_eq!(fr.len(), 3);
        assert_eq!(
            fr[0],
            f(
                "submit",
                "https://terminal.fxglory.com/_nuxt/OrderPanel.Cx1aB2.js",
                1,
                2345
            )
        );
        assert_eq!(fr[1].function, "setup/</<");
        assert_eq!(fr[2], f("", "https://terminal.fxglory.com/_nuxt/entry.js", 5, 1));
    }

    #[test]
    fn jsc_safari() {
        let s = "submit@https://terminal.fxglory.com/_nuxt/OrderPanel.js:1:2345\nglobal code@https://terminal.fxglory.com/trade:10:3\n[native code]\nhttps://terminal.fxglory.com/_nuxt/entry.js:3:999\nmap@[native code]";
        let fr = parse(s);
        assert_eq!(fr.len(), 5);
        assert_eq!(fr[1].function, "global code");
        assert_eq!(fr[2], Frame::default());
        assert_eq!(
            fr[3],
            f("", "https://terminal.fxglory.com/_nuxt/entry.js", 3, 999)
        );
        assert_eq!(fr[4], f("map", "", 0, 0));
    }

    #[test]
    fn garbage_and_limits() {
        assert!(parse("").is_empty());
        assert!(parse("Error: boom").is_empty());
        let deep: String = (0..200)
            .map(|i| format!("    at f{i} (https://a/b.js:1:{i})\n"))
            .collect();
        assert_eq!(parse(&deep).len(), MAX_FRAMES);
    }
}
