//! Viewer-role recordings (PRD §5.10/§5.11, T-35): a copy of the `.rpl` with network headers/bodies and
//! WebSocket frame contents removed. This decodes replay payloads, which is allowed here: it runs on the
//! dashboard API path, never on ingest (rule 5).
//!
//! * `network` custom events lose `reqHeaders`, `resHeaders`, `reqBody`, `resBody` (method, URL, status,
//!   timings and sizes stay).
//! * `ws` custom events lose `raw`; `len` keeps the frame length.
//! * Assets are dropped (canvas is out of scope; nothing else stores bytes there).
//! * Frames are deduped/sorted by `seq` and flagged [`FLAG_REDACTED`]. Undecodable frames become empty gap frames.
//!
//! The result is cached next to the original as `<day>/.redacted/<sid>.<len>.rpl`, keyed by the source length,
//! which only grows. The day directory is removed by retention together with it.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use bytes::Bytes;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use replayd_common::rpl::{self, FLAG_GAP, FLAG_REDACTED, FrameHeader};
use serde_json::Value;

/// Largest decoded events JSON per frame we accept (segments are ≤ 256 KB raw; huge values are hostile).
const MAX_JSON: u64 = 16 << 20;
const NETWORK_KEYS: &[&str] = &["reqHeaders", "resHeaders", "reqBody", "resBody"];

fn strip(ev: &mut Value) -> bool {
    let Some(arr) = ev.as_array_mut() else {
        return false;
    };
    let mut changed = false;
    for e in arr {
        if e.get("type").and_then(Value::as_u64) != Some(5) {
            continue;
        }
        let tag = e["data"]["tag"].as_str().unwrap_or_default().to_string();
        let Some(p) = e
            .get_mut("data")
            .and_then(|d| d.get_mut("payload"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        match tag.as_str() {
            "network" => {
                for k in NETWORK_KEYS {
                    changed |= p.remove(*k).is_some();
                }
            }
            "ws" => {
                if let Some(Value::String(r)) = p.remove("raw") {
                    p.insert("len".into(), Value::from(r.len()));
                    p.insert("redacted".into(), Value::Bool(true));
                    changed = true;
                }
            }
            _ => {}
        }
    }
    changed
}

fn gunzip(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![];
    GzDecoder::new(b).take(MAX_JSON + 1).read_to_end(&mut out).ok()?;
    (out.len() as u64 <= MAX_JSON).then_some(out)
}

fn frame_body(events_gz: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(events_gz.len() + 6);
    b.extend_from_slice(&(events_gz.len() as u32).to_le_bytes());
    b.extend_from_slice(events_gz);
    b.extend_from_slice(&0u16.to_le_bytes());
    b
}

/// Filtered copy of an `.rpl` buffer.
pub fn redact(src: &[u8]) -> Result<Vec<u8>, rpl::RplError> {
    let idx = rpl::index(src)?;
    let mut out = Vec::with_capacity(src.len());
    out.extend_from_slice(&rpl::encode_header(&idx.sid));
    for f in &idx.frames {
        let body = Bytes::copy_from_slice(&src[f.body_range()]);
        let mut h: FrameHeader = f.header;
        let gz = replayd_common::wire::parse_stored_body(&body)
            .ok()
            .and_then(|(events, _assets)| gunzip(&events))
            .and_then(|json| serde_json::from_slice::<Value>(&json).ok())
            .and_then(|mut v| {
                strip(&mut v);
                let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
                enc.write_all(&serde_json::to_vec(&v).ok()?).ok()?;
                enc.finish().ok()
            });
        let gz = match gz {
            Some(g) => g,
            None => {
                // never pass an undecodable frame through unfiltered
                h.flags |= FLAG_GAP;
                let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
                let _ = enc.write_all(b"[]");
                enc.finish().unwrap_or_default()
            }
        };
        let b = frame_body(&gz);
        h.len = b.len() as u32;
        h.flags |= FLAG_REDACTED;
        out.extend_from_slice(&h.encode());
        out.extend_from_slice(&b);
    }
    Ok(out)
}

/// Path of the cached viewer copy for a source file of `len` bytes.
pub fn cache_path(src: &Path, len: u64) -> PathBuf {
    let dir = src.parent().unwrap_or(Path::new(".")).join(".redacted");
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("x");
    dir.join(format!("{stem}.{len}.rpl"))
}

/// Returns the cached viewer copy, building it (atomically) if missing; older copies of the same session are
/// removed. Blocking: call from `spawn_blocking`.
pub fn ensure(src: &Path) -> std::io::Result<PathBuf> {
    let len = std::fs::metadata(src)?.len();
    let dst = cache_path(src, len);
    if dst.exists() {
        return Ok(dst);
    }
    let buf = std::fs::read(src)?;
    let out =
        redact(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    let dir = dst.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let stem = format!("{}.", src.file_stem().and_then(|s| s.to_str()).unwrap_or("x"));
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&stem) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let tmp = dst.with_extension("tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, &dst)?;
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gz(v: &Value) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::fast());
        e.write_all(v.to_string().as_bytes()).unwrap();
        e.finish().unwrap()
    }

    pub fn sample() -> Vec<u8> {
        let events = json!([
            {"type": 2, "timestamp": 1, "data": {"node": {"id": 1}}},
            {"type": 5, "timestamp": 2, "data": {"tag": "network", "payload": {"method": "POST", "type": "xhr", "url": "https://api/x", "status": 200,
                "reqHeaders": {"content-type": "application/json"}, "reqBody": "{\"pin\":\"[Filtered]\",\"amount\":5}",
                "resHeaders": {"x": "y"}, "resBody": "{\"balance\":12345.67}"}}},
            {"type": 5, "timestamp": 3, "data": {"tag": "ws", "payload": {"k": "frame", "id": 1, "dir": "in", "raw": "{\"push\":{\"channel\":\"orders:10023451\"}}"}}},
            {"type": 5, "timestamp": 4, "data": {"tag": "console", "payload": {"level": "log", "args": ["hi"]}}}
        ]);
        let mut f = rpl::encode_header(&[7u8; 16]).to_vec();
        for seq in [1u32, 0, 1] {
            let b = frame_body(&gz(&events));
            let h = FrameHeader {
                len: b.len() as u32,
                seq,
                t0: 1,
                t1: 4,
                received_at: 0,
                flags: 0,
            };
            f.extend_from_slice(&h.encode());
            f.extend_from_slice(&b);
        }
        // corrupt frame (not gzip)
        let b = frame_body(b"not gzip");
        let h = FrameHeader {
            len: b.len() as u32,
            seq: 2,
            t0: 5,
            t1: 5,
            received_at: 0,
            flags: 0,
        };
        f.extend_from_slice(&h.encode());
        f.extend_from_slice(&b);
        f
    }

    #[test]
    fn strips_bodies_headers_and_frames() {
        let out = redact(&sample()).unwrap();
        let idx = rpl::index(&out).unwrap();
        assert_eq!(idx.frames.len(), 3, "deduped by seq");
        for f in &idx.frames {
            assert!(f.header.flags & FLAG_REDACTED != 0);
            let (ev, assets) =
                replayd_common::wire::parse_stored_body(&Bytes::copy_from_slice(&out[f.body_range()]))
                    .unwrap();
            assert!(assets.is_empty());
            let json = String::from_utf8(gunzip(&ev).unwrap()).unwrap();
            for secret in [
                "reqBody",
                "resBody",
                "reqHeaders",
                "resHeaders",
                "balance",
                "orders:10023451",
                "\"raw\"",
            ] {
                assert!(!json.contains(secret), "{secret} leaked in {json}");
            }
            if f.header.seq == 2 {
                assert_eq!(json, "[]");
                assert!(f.header.flags & FLAG_GAP != 0);
            } else {
                let v: Value = serde_json::from_str(&json).unwrap();
                assert_eq!(v[1]["data"]["payload"]["status"], 200);
                assert_eq!(v[1]["data"]["payload"]["type"], "xhr");
                assert_eq!(v[2]["data"]["payload"]["len"], 38); // length of the raw frame
                assert_eq!(v[3]["data"]["payload"]["args"][0], "hi");
            }
        }
    }

    #[test]
    fn caches_per_source_length() {
        let dir = std::env::temp_dir().join(format!("rp-red-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("s.rpl");
        std::fs::write(&src, sample()).unwrap();
        let a = ensure(&src).unwrap();
        assert_eq!(ensure(&src).unwrap(), a);
        // the live file grew → new copy, old one removed
        let mut grown = sample();
        grown.extend_from_slice(&sample()[22..]);
        std::fs::write(&src, grown).unwrap();
        let b = ensure(&src).unwrap();
        assert_ne!(a, b);
        assert!(!a.exists() && b.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
