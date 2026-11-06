//! Replay segment wire format (PRD §4.10), little-endian:
//!
//! ```text
//! u16 meta_len | meta JSON
//! u32 events_len | events (gzip JSON array of rrweb events)
//! u16 asset_count | { u32 asset_id | u8 type (1=webp) | u32 len | bytes } × asset_count
//! ```
//!
//! Parsing is zero-copy and **never decompresses** the events payload (AGENTS.md rule 5): it only checks
//! lengths and the gzip magic. The bytes after the meta block ("body without meta") are stored verbatim in
//! the session's `.rpl` file.

use bytes::Bytes;
use serde::{Deserialize, Serialize};

/// Owner-approved metadata envelope, including up to 16 KiB of custom fields.
pub const MAX_META_LEN: usize = 32 * 1024;
/// Maximum number of assets in one segment.
pub const MAX_ASSETS: usize = 256;
/// gzip magic bytes.
pub const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Asset type ids.
pub const ASSET_WEBP: u8 = 1;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("body truncated at {0}")]
    Truncated(&'static str),
    #[error("meta too large")]
    MetaTooLarge,
    #[error("invalid meta json: {0}")]
    MetaJson(String),
    #[error("events payload is not gzip")]
    NotGzip,
    #[error("too many assets")]
    TooManyAssets,
    #[error("unknown asset type {0}")]
    AssetType(u8),
    #[error("trailing bytes after asset section")]
    Trailing,
}

/// Session-level data sent with each segment; `init` is present on seq 0 (and may be repeated).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SegmentInit {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default, rename = "ref")]
    pub referrer: Option<String>,
    #[serde(default)]
    pub ua: Option<String>,
    #[serde(default)]
    pub vw: Option<i32>,
    #[serde(default)]
    pub vh: Option<i32>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub release: Option<String>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub app_ver: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub os_ver: Option<String>,
    #[serde(default)]
    pub wv_ver: Option<String>,
    #[serde(default)]
    pub user: Option<SegmentUser>,
    #[serde(default)]
    pub tags: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub local_time: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SegmentUser {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Complete snapshot. A null user and empty custom object explicitly clear previous values.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SegmentFields {
    #[serde(default)]
    pub user: Option<SegmentUser>,
    pub custom_fields: serde_json::Value,
    #[serde(default)]
    pub app_ver: Option<String>,
}

/// Segment meta JSON (PRD §4.10).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SegmentMeta {
    pub sid: String,
    pub seq: u32,
    pub t0: u64,
    pub t1: u64,
    #[serde(default = "default_enc")]
    pub enc: String,
    #[serde(default)]
    pub n: u32,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub clicks: u32,
    #[serde(default)]
    pub errs: u32,
    #[serde(default)]
    pub warns: u32,
    #[serde(default)]
    pub has_error: bool,
    #[serde(default)]
    pub ws_disc: u32,
    #[serde(default)]
    pub canvas_bytes: u64,
    #[serde(default)]
    pub gap: bool,
    /// SDK internal error counter (§4.11), exported as `replayd_sdk_internal_errors_total`.
    #[serde(default)]
    pub ie: u32,
    #[serde(default)]
    pub init: Option<SegmentInit>,
    #[serde(default)]
    pub fields: Option<SegmentFields>,
}

fn default_enc() -> String {
    "gzip".into()
}

/// One binary asset (e.g. a WebP canvas frame). Canvas capture is out of scope for v1 (D-01) but the
/// section is parsed so it can be added without a format change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub id: u32,
    pub kind: u8,
    pub data: Bytes,
}

/// A parsed replay segment. `body` is everything after the meta block, stored as-is on disk.
#[derive(Debug, Clone)]
pub struct ReplaySegment {
    pub meta: SegmentMeta,
    pub body: Bytes,
    pub events: Bytes,
    pub assets: Vec<Asset>,
}

struct Cursor<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize, what: &'static str) -> Result<std::ops::Range<usize>, WireError> {
        let end = self.pos.checked_add(n).ok_or(WireError::Truncated(what))?;
        if end > self.b.len() {
            return Err(WireError::Truncated(what));
        }
        let r = self.pos..end;
        self.pos = end;
        Ok(r)
    }
    fn u8(&mut self, what: &'static str) -> Result<u8, WireError> {
        let r = self.take(1, what)?;
        Ok(self.b[r.start])
    }
    fn u16(&mut self, what: &'static str) -> Result<u16, WireError> {
        let r = self.take(2, what)?;
        Ok(u16::from_le_bytes([self.b[r.start], self.b[r.start + 1]]))
    }
    fn u32(&mut self, what: &'static str) -> Result<u32, WireError> {
        let r = self.take(4, what)?;
        let s = &self.b[r];
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
}

/// Validates the body-without-meta section (events + assets) and returns (events range, assets).
fn parse_after_meta(all: &Bytes, start: usize) -> Result<(Bytes, Vec<Asset>), WireError> {
    let mut c = Cursor { b: all, pos: start };
    let events_len = c.u32("events_len")? as usize;
    let er = c.take(events_len, "events")?;
    if events_len < 2 || all[er.start..er.start + 2] != GZIP_MAGIC {
        return Err(WireError::NotGzip);
    }
    let count = c.u16("asset_count")? as usize;
    if count > MAX_ASSETS {
        return Err(WireError::TooManyAssets);
    }
    let mut assets = Vec::with_capacity(count);
    for _ in 0..count {
        let id = c.u32("asset_id")?;
        let kind = c.u8("asset_type")?;
        if kind != ASSET_WEBP {
            return Err(WireError::AssetType(kind));
        }
        let len = c.u32("asset_len")? as usize;
        let r = c.take(len, "asset")?;
        assets.push(Asset {
            id,
            kind,
            data: all.slice(r),
        });
    }
    if c.pos != all.len() {
        return Err(WireError::Trailing);
    }
    Ok((all.slice(er), assets))
}

/// Parses a `POST /ingest/:pid/replay` body. O(meta) work; payload bytes are only sliced.
pub fn parse_replay_body(body: &Bytes) -> Result<ReplaySegment, WireError> {
    let mut c = Cursor { b: body, pos: 0 };
    let meta_len = c.u16("meta_len")? as usize;
    if meta_len > MAX_META_LEN {
        return Err(WireError::MetaTooLarge);
    }
    let mr = c.take(meta_len, "meta")?;
    let meta: SegmentMeta =
        serde_json::from_slice(&body[mr]).map_err(|e| WireError::MetaJson(e.to_string()))?;
    let after = c.pos;
    let (events, assets) = parse_after_meta(body, after)?;
    Ok(ReplaySegment {
        meta,
        body: body.slice(after..),
        events,
        assets,
    })
}

/// Parses a stored body-without-meta (as found in a `.rpl` frame).
pub fn parse_stored_body(body: &Bytes) -> Result<(Bytes, Vec<Asset>), WireError> {
    parse_after_meta(body, 0)
}

/// Encodes a replay body (used by tests, the load generator and fixtures; the SDK has its own TS encoder).
pub fn encode_replay_body(meta_json: &[u8], events_gz: &[u8], assets: &[Asset]) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        2 + meta_json.len()
            + 4
            + events_gz.len()
            + 2
            + assets.iter().map(|a| 9 + a.data.len()).sum::<usize>(),
    );
    out.extend_from_slice(&(meta_json.len() as u16).to_le_bytes());
    out.extend_from_slice(meta_json);
    out.extend_from_slice(&(events_gz.len() as u32).to_le_bytes());
    out.extend_from_slice(events_gz);
    out.extend_from_slice(&(assets.len() as u16).to_le_bytes());
    for a in assets {
        out.extend_from_slice(&a.id.to_le_bytes());
        out.push(a.kind);
        out.extend_from_slice(&(a.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&a.data);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Vec<u8> {
        br#"{"sid":"0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d","seq":3,"t0":1730620000123,"t1":1730620005120,"n":2}"#.to_vec()
    }

    #[test]
    fn roundtrip_with_assets() {
        let gz = [0x1f, 0x8b, 8, 0, 1, 2, 3];
        let assets = vec![Asset {
            id: 7,
            kind: ASSET_WEBP,
            data: Bytes::from_static(b"RIFFxxxxWEBP"),
        }];
        let body = Bytes::from(encode_replay_body(&meta(), &gz, &assets));
        let seg = parse_replay_body(&body).unwrap();
        assert_eq!(seg.meta.seq, 3);
        assert_eq!(seg.meta.enc, "gzip");
        assert_eq!(&seg.events[..], &gz);
        assert_eq!(seg.assets, assets);
        let (ev, a2) = parse_stored_body(&seg.body).unwrap();
        assert_eq!(&ev[..], &gz);
        assert_eq!(a2, assets);
    }

    #[test]
    fn metadata_envelope_fits_full_custom_fields_and_rejects_over_32k() {
        let mut m: serde_json::Value = serde_json::from_slice(&meta()).unwrap();
        m["fields"] = serde_json::json!({"user":null,"custom_fields":{"x":"x".repeat(16384-8)}});
        let b = encode_replay_body(&serde_json::to_vec(&m).unwrap(), &[0x1f, 0x8b, 8], &[]);
        assert!(parse_replay_body(&Bytes::from(b)).is_ok());
        m["padding"] = serde_json::json!("x".repeat(32768));
        let b = encode_replay_body(&serde_json::to_vec(&m).unwrap(), &[0x1f, 0x8b, 8], &[]);
        assert_eq!(
            parse_replay_body(&Bytes::from(b)).unwrap_err(),
            WireError::MetaTooLarge
        );
    }

    #[test]
    fn rejects_bad_input() {
        let gz = [0x1f, 0x8b, 8];
        let ok = encode_replay_body(&meta(), &gz, &[]);
        for cut in 0..ok.len() {
            assert!(
                parse_replay_body(&Bytes::copy_from_slice(&ok[..cut])).is_err(),
                "cut {cut}"
            );
        }
        let not_gz = encode_replay_body(&meta(), b"{}[]", &[]);
        assert_eq!(
            parse_replay_body(&Bytes::from(not_gz)).unwrap_err(),
            WireError::NotGzip
        );
        let mut trailing = ok.clone();
        trailing.push(0);
        assert_eq!(
            parse_replay_body(&Bytes::from(trailing)).unwrap_err(),
            WireError::Trailing
        );
        let bad_meta = encode_replay_body(b"{\"sid\":1}", &gz, &[]);
        assert!(matches!(
            parse_replay_body(&Bytes::from(bad_meta)),
            Err(WireError::MetaJson(_))
        ));
    }
}
