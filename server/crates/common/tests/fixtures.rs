//! Cross-language fixtures (see /fixtures/wire/README.md): TS-encoded segment → Rust parser,
//! Rust-written `.rpl` → TS reader. `REPLAYD_REGEN_FIXTURES=1` rewrites `session.rpl`.

use std::io::Read;
use std::path::PathBuf;

use bytes::Bytes;
use replayd_common::{ids, rpl, wire};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/wire")
}

fn gunzip(b: &[u8]) -> String {
    let mut s = String::new();
    flate2::read::GzDecoder::new(b).read_to_string(&mut s).unwrap();
    s
}

#[test]
fn ts_segment_parses_in_rust() {
    let bin = Bytes::from(std::fs::read(dir().join("segment.bin")).unwrap());
    let seg = wire::parse_replay_body(&bin).unwrap();
    let expected: wire::SegmentMeta =
        serde_json::from_slice(&std::fs::read(dir().join("segment.meta.json")).unwrap()).unwrap();
    assert_eq!(seg.meta, expected);
    let init = seg.meta.init.as_ref().unwrap();
    assert_eq!(init.platform.as_deref(), Some("capacitor-android"));
    assert_eq!(init.user.as_ref().unwrap().id.as_deref(), Some("10023451"));
    let events = std::fs::read_to_string(dir().join("events.json")).unwrap();
    assert_eq!(gunzip(&seg.events), events.trim());
    assert_eq!(seg.assets.len(), 1);
    assert_eq!(seg.assets[0].id, 7);
    assert_eq!(&seg.assets[0].data[..], b"RIFFxxxxWEBP");
}

/// Builds the `.rpl` fixture: frames seq 1, 0 (has_error), duplicate 1, then a truncated seq 2.
fn build_rpl(seg: &wire::ReplaySegment) -> Vec<u8> {
    let sid = ids::parse_sid(&seg.meta.sid).unwrap();
    let mut out = rpl::encode_header(sid.as_bytes()).to_vec();
    let frame = |seq: u32, flags: u8| {
        let h = rpl::FrameHeader {
            len: seg.body.len() as u32,
            seq,
            t0: seg.meta.t0,
            t1: seg.meta.t1,
            received_at: 1_730_620_006,
            flags,
        };
        let mut v = h.encode().to_vec();
        v.extend_from_slice(&seg.body);
        v
    };
    out.extend(frame(1, 0));
    out.extend(frame(0, rpl::FLAG_HAS_ERROR));
    out.extend(frame(1, 0));
    let mut tail = frame(2, 0);
    tail.truncate(rpl::FRAME_HEADER_LEN + 10);
    out.extend(tail);
    out
}

#[test]
fn rust_rpl_matches_fixture_and_indexes() {
    let bin = Bytes::from(std::fs::read(dir().join("segment.bin")).unwrap());
    let seg = wire::parse_replay_body(&bin).unwrap();
    let built = build_rpl(&seg);
    let path = dir().join("session.rpl");
    if std::env::var("REPLAYD_REGEN_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&path, &built).unwrap();
    }
    let committed = std::fs::read(&path).unwrap();
    assert_eq!(
        committed, built,
        "session.rpl differs from the Rust writer output"
    );

    let idx = rpl::index(&committed).unwrap();
    assert_eq!(
        idx.frames.iter().map(|f| f.header.seq).collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(idx.duplicates, 1);
    assert!(idx.valid_len < committed.len());
    for f in &idx.frames {
        let body = Bytes::copy_from_slice(&committed[f.body_range()]);
        let (events, assets) = wire::parse_stored_body(&body).unwrap();
        assert_eq!(
            gunzip(&events),
            std::fs::read_to_string(dir().join("events.json")).unwrap().trim()
        );
        assert_eq!(assets.len(), 1);
    }
}
