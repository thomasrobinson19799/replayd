//! Source-map symbolication (PRD §5.5 step 3, §5.6).
//!
//! Maps are stored per project and release as `data/_sourcemaps/<pid>/<release>/<sha1(~/path)>.map`, keyed by
//! the `~/path` of the minified file. URL normalization already maps `https://localhost/_nuxt/x.js` (APK) and
//! `https://terminal.example.com/_nuxt/x.js` (web) to the same `~/_nuxt/x.js`, so one upload serves both.
//!
//! Parsed maps are kept in a small LRU (count-bounded, memory-heavy entries). Misses are cached too and
//! the whole release is invalidated on upload. Reads are synchronous: a map is read once, then cached.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use sha1::{Digest, Sha1};
use sourcemap::{DecodedMap, SourceMap};

use crate::stack::{Frame, OrigFrame};

/// Parsed maps kept in memory (each can be tens of MB parsed for big bundles).
const CACHE: usize = 32;
/// Context lines around the original line.
const CONTEXT: usize = 5;
const MAX_LINE: usize = 240;

type Key = (i32, String, String);

pub struct SourceMaps {
    root: PathBuf,
    cache: Mutex<Lru>,
}

struct Lru {
    tick: u64,
    map: HashMap<Key, (u64, Option<Arc<SourceMap>>)>,
}

/// Directory-safe release name: `[A-Za-z0-9._+-]` kept, everything else `%XX`; `.`/`..` can't escape.
pub fn release_dir(release: &str) -> String {
    let mut s = String::with_capacity(release.len());
    for b in release.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-') || (b == b'.' && !s.is_empty()) {
            s.push(b as char);
        } else {
            s.push_str(&format!("%{b:02X}"));
        }
    }
    s
}

/// File name of the map for a minified file's `~/path`.
pub fn map_file(path: &str) -> String {
    let h = Sha1::digest(path.as_bytes());
    let mut s = String::with_capacity(44);
    for b in h {
        s.push_str(&format!("{b:02x}"));
    }
    s.push_str(".map");
    s
}

/// `webpack:///./src/a.ts`, `../../app/components/X.vue`, `/@fs/abs/x.ts` → `src/a.ts`, `app/components/X.vue`
pub fn clean_source(s: &str) -> String {
    let mut s = s;
    for p in ["webpack:///", "webpack://", "vite:///", "file://"] {
        if let Some(r) = s.strip_prefix(p) {
            s = r;
        }
    }
    let mut out: Vec<&str> = vec![];
    for seg in s.split('/') {
        match seg {
            "" | "." | ".." => {}
            x => out.push(x),
        }
    }
    out.join("/")
}

fn clip(s: &str) -> String {
    if s.len() <= MAX_LINE {
        return s.to_string();
    }
    let mut end = MAX_LINE;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

impl SourceMaps {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            root: data_dir.join("_sourcemaps"),
            cache: Mutex::new(Lru {
                tick: 0,
                map: HashMap::new(),
            }),
        })
    }

    pub fn release_path(&self, project_id: i32, release: &str) -> PathBuf {
        self.root.join(project_id.to_string()).join(release_dir(release))
    }

    /// Drops cached maps and misses of one release (after an upload).
    pub fn invalidate(&self, project_id: i32, release: &str) {
        self.cache
            .lock()
            .map
            .retain(|k, _| !(k.0 == project_id && k.1 == release));
    }

    fn get(&self, project_id: i32, release: &str, path: &str) -> Option<Arc<SourceMap>> {
        let key = (project_id, release.to_string(), path.to_string());
        {
            let mut c = self.cache.lock();
            c.tick += 1;
            let t = c.tick;
            if let Some(e) = c.map.get_mut(&key) {
                e.0 = t;
                return e.1.clone();
            }
        }
        let file = self.release_path(project_id, release).join(map_file(path));
        let parsed = std::fs::read(&file).ok().and_then(|b| match sourcemap::decode_slice(&b) {
            Ok(DecodedMap::Regular(m)) => Some(Arc::new(m)),
            Ok(DecodedMap::Index(i)) => i.flatten().ok().map(Arc::new),
            _ => None,
        });
        let mut c = self.cache.lock();
        if c.map.len() >= CACHE
            && let Some(old) = c.map.iter().min_by_key(|(_, v)| v.0).map(|(k, _)| k.clone())
        {
            c.map.remove(&old);
        }
        let t = c.tick;
        c.map.insert(key, (t, parsed.clone()));
        parsed
    }

    /// Fills `orig` (file, line, col, name, context) for every frame with a map. Returns true if any frame
    /// was symbolicated. Frames from `node_modules` sources become not in-app.
    pub fn symbolicate(&self, project_id: i32, release: &str, frames: &mut [Frame]) -> bool {
        let mut any = false;
        for f in frames.iter_mut() {
            if f.path.is_empty() || f.line == 0 || f.orig.is_some() {
                continue;
            }
            let Some(sm) = self.get(project_id, release, &f.path) else {
                continue;
            };
            let Some(tok) = sm.lookup_token(f.line - 1, f.col.saturating_sub(1)) else {
                continue;
            };
            let Some(src) = tok.get_source() else { continue };
            let line = tok.get_src_line() as usize;
            let mut o = OrigFrame {
                file: clean_source(src),
                line: line as u32 + 1,
                col: tok.get_src_col() + 1,
                function: tok.get_name().unwrap_or(&f.function).to_string(),
                ..Default::default()
            };
            if let Some(content) = sm.get_source_contents(tok.get_src_id()) {
                let lines: Vec<&str> = content.lines().collect();
                if line < lines.len() {
                    o.pre = lines[line.saturating_sub(CONTEXT)..line].iter().map(|l| clip(l)).collect();
                    o.context = clip(lines[line]);
                    o.post = lines[line + 1..(line + 1 + CONTEXT).min(lines.len())]
                        .iter()
                        .map(|l| clip(l))
                        .collect();
                }
            }
            if o.file.contains("node_modules/") {
                f.in_app = false;
            }
            f.orig = Some(o);
            any = true;
        }
        any
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // tiny map: minified `a.js` line 1 col 10 → src/order.ts line 3 col 5, name "placeOrder"
    // generated with source-map 0.7 conventions; mappings "SAEI,SAAA" style computed below by the builder
    fn write_map(dir: &Path, path: &str) {
        let mut b = sourcemap::SourceMapBuilder::new(Some("a.js"));
        let src = b.add_source("../../src/order.ts");
        b.set_source_contents(src, Some("// order\nexport function placeOrder(o) {\n    return o.price.toFixed(2);\n}\n"));
        b.add_raw(0, 9, 2, 4, Some(src), b.add_name("price").into(), false);
        b.add_raw(0, 30, 0, 0, Some(src), None, false);
        let sm = b.into_sourcemap();
        let mut out = vec![];
        sm.to_writer(&mut out).unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(map_file(path)), out).unwrap();
    }

    #[test]
    fn release_dir_is_safe() {
        assert_eq!(release_dir("1.42.0"), "1.42.0");
        assert_eq!(release_dir("1.42.0 (142)"), "1.42.0%20%28142%29");
        assert_eq!(release_dir(".."), "%2E.");
        assert_eq!(release_dir("a/../b"), "a%2F..%2Fb");
    }

    #[test]
    fn cleans_sources() {
        assert_eq!(clean_source("webpack:///./src/a.ts"), "src/a.ts");
        assert_eq!(clean_source("../../app/components/X.vue"), "app/components/X.vue");
        assert_eq!(clean_source("../node_modules/vue/dist/x.js"), "node_modules/vue/dist/x.js");
    }

    #[test]
    fn symbolicates_with_context_and_caches_misses() {
        let tmp = std::env::temp_dir().join(format!("rp-sm-{}", std::process::id()));
        let sm = SourceMaps::new(&tmp);
        let mut frames = vec![Frame {
            function: "a".into(),
            url: "https://localhost/_nuxt/a.js".into(),
            line: 1,
            col: 12,
            path: "~/_nuxt/a.js".into(),
            in_app: true,
            orig: None,
        }];
        // not uploaded yet: miss is cached …
        assert!(!sm.symbolicate(7, "1.0.0", &mut frames));
        write_map(&sm.release_path(7, "1.0.0"), "~/_nuxt/a.js");
        assert!(!sm.symbolicate(7, "1.0.0", &mut frames));
        // … until the release is invalidated by an upload
        sm.invalidate(7, "1.0.0");
        assert!(sm.symbolicate(7, "1.0.0", &mut frames));
        let o = frames[0].orig.as_ref().unwrap();
        assert_eq!((o.file.as_str(), o.line, o.col), ("src/order.ts", 3, 5));
        assert_eq!(o.function, "price");
        assert_eq!(o.context, "    return o.price.toFixed(2);");
        assert_eq!(o.pre, vec!["// order", "export function placeOrder(o) {"]);
        assert_eq!(o.post, vec!["}"]);
        // other release: no map
        let mut f2 = vec![Frame { orig: None, ..frames[0].clone() }];
        assert!(!sm.symbolicate(7, "2.0.0", &mut f2));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
