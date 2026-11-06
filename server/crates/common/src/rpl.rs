//! `.rpl` session recording file (PRD §5.3), little-endian:
//!
//! ```text
//! header: "RPL2" | u16 version | 16-byte sid                          (22 bytes)
//! frame:  u32 len | u32 seq | u64 t0 | u64 t1 | u32 received_at | u8 flags | body   (29-byte header)
//! ```
//!
//! * `len` is the byte length of `body` (the segment body without meta, see [`crate::wire`]).
//! * `t0`/`t1` are the segment's client timestamps (ms since epoch); `received_at` is the server receive
//!   time in seconds since the Unix epoch.
//! * Frames are appended in arrival order; out-of-order and duplicate `seq` are allowed on disk. Readers sort
//!   by `seq` and keep the first copy of each `seq`.
//! * A crash can leave a truncated last frame; readers ignore a partial tail.

pub const MAGIC: &[u8; 4] = b"RPL2";
pub const VERSION: u16 = 1;
pub const HEADER_LEN: usize = 22;
pub const FRAME_HEADER_LEN: usize = 29;
/// Largest frame body accepted by readers (ingest caps bodies at 2 MB).
pub const MAX_FRAME_LEN: u32 = 4 * 1024 * 1024;

/// Frame flag bits.
pub const FLAG_GAP: u8 = 1;
pub const FLAG_HAS_ERROR: u8 = 1 << 1;
/// Body was filtered for the viewer role (network bodies / WS payloads removed).
pub const FLAG_REDACTED: u8 = 1 << 2;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RplError {
    #[error("not an .rpl file")]
    BadMagic,
    #[error("unsupported .rpl version {0}")]
    Version(u16),
    #[error("file shorter than header")]
    Short,
}

/// Local path of a recording: `data/<project_id>/<YYYY-MM-DD of session start>/<sid>.rpl`.
pub fn recording_path(
    data_dir: &std::path::Path,
    project_id: i32,
    day: &str,
    sid: &str,
) -> std::path::PathBuf {
    data_dir
        .join(project_id.to_string())
        .join(day)
        .join(format!("{sid}.rpl"))
}

pub fn encode_header(sid: &[u8; 16]) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[..4].copy_from_slice(MAGIC);
    h[4..6].copy_from_slice(&VERSION.to_le_bytes());
    h[6..].copy_from_slice(sid);
    h
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub len: u32,
    pub seq: u32,
    pub t0: u64,
    pub t1: u64,
    pub received_at: u32,
    pub flags: u8,
}

impl FrameHeader {
    pub fn encode(&self) -> [u8; FRAME_HEADER_LEN] {
        let mut h = [0u8; FRAME_HEADER_LEN];
        h[0..4].copy_from_slice(&self.len.to_le_bytes());
        h[4..8].copy_from_slice(&self.seq.to_le_bytes());
        h[8..16].copy_from_slice(&self.t0.to_le_bytes());
        h[16..24].copy_from_slice(&self.t1.to_le_bytes());
        h[24..28].copy_from_slice(&self.received_at.to_le_bytes());
        h[28] = self.flags;
        h
    }

    pub fn decode(b: &[u8]) -> Option<Self> {
        if b.len() < FRAME_HEADER_LEN {
            return None;
        }
        let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let u64_at = |i: usize| {
            let mut x = [0u8; 8];
            x.copy_from_slice(&b[i..i + 8]);
            u64::from_le_bytes(x)
        };
        Some(Self {
            len: u32_at(0),
            seq: u32_at(4),
            t0: u64_at(8),
            t1: u64_at(16),
            received_at: u32_at(24),
            flags: b[28],
        })
    }
}

/// Location of one frame inside a file buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameRef {
    pub header: FrameHeader,
    /// Offset of the frame header in the file.
    pub offset: usize,
}

impl FrameRef {
    pub fn body_range(&self) -> std::ops::Range<usize> {
        let s = self.offset + FRAME_HEADER_LEN;
        s..s + self.header.len as usize
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RplIndex {
    pub sid: [u8; 16],
    /// Frames sorted by `seq`, first copy of each `seq` only.
    pub frames: Vec<FrameRef>,
    /// Byte length of the valid prefix (a truncated tail is excluded).
    pub valid_len: usize,
    /// Number of duplicate frames skipped.
    pub duplicates: usize,
}

/// Indexes an `.rpl` buffer: validates the header, walks frames, ignores a truncated tail,
/// dedups by `seq` (first copy wins) and sorts by `seq`.
pub fn index(buf: &[u8]) -> Result<RplIndex, RplError> {
    if buf.len() < HEADER_LEN {
        return Err(RplError::Short);
    }
    if &buf[..4] != MAGIC {
        return Err(RplError::BadMagic);
    }
    let v = u16::from_le_bytes([buf[4], buf[5]]);
    if v != VERSION {
        return Err(RplError::Version(v));
    }
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&buf[6..22]);
    let mut frames = Vec::new();
    let mut pos = HEADER_LEN;
    while let Some(h) = FrameHeader::decode(&buf[pos..]) {
        if h.len > MAX_FRAME_LEN {
            break; // corrupt tail
        }
        let end = pos + FRAME_HEADER_LEN + h.len as usize;
        if end > buf.len() {
            break; // truncated by a crash
        }
        frames.push(FrameRef {
            header: h,
            offset: pos,
        });
        pos = end;
    }
    // stable sort keeps arrival order among equal seq → dedup keeps the first copy
    frames.sort_by_key(|f| f.header.seq);
    let before = frames.len();
    frames.dedup_by_key(|f| f.header.seq);
    Ok(RplIndex {
        sid,
        duplicates: before - frames.len(),
        frames,
        valid_len: pos,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u32, body: &[u8]) -> Vec<u8> {
        let h = FrameHeader {
            len: body.len() as u32,
            seq,
            t0: 1_730_620_000_000 + seq as u64,
            t1: 1_730_620_005_000 + seq as u64,
            received_at: 1_730_620_006,
            flags: if seq == 2 { FLAG_HAS_ERROR } else { 0 },
        };
        let mut v = h.encode().to_vec();
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn header_roundtrip() {
        let h = FrameHeader {
            len: 5,
            seq: 9,
            t0: u64::MAX - 1,
            t1: 3,
            received_at: 7,
            flags: 5,
        };
        assert_eq!(FrameHeader::decode(&h.encode()), Some(h));
    }

    #[test]
    fn sorts_dedups_and_tolerates_truncation() {
        let sid = [7u8; 16];
        let mut buf = encode_header(&sid).to_vec();
        buf.extend(frame(1, b"one"));
        buf.extend(frame(0, b"zero"));
        buf.extend(frame(1, b"dup"));
        buf.extend(frame(2, b"two"));
        let full = buf.len();
        let mut partial = frame(3, b"three-truncated");
        partial.truncate(FRAME_HEADER_LEN + 4);
        buf.extend(partial);

        let idx = index(&buf).unwrap();
        assert_eq!(idx.sid, sid);
        assert_eq!(idx.valid_len, full);
        assert_eq!(idx.duplicates, 1);
        let seqs: Vec<u32> = idx.frames.iter().map(|f| f.header.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2]);
        assert_eq!(&buf[idx.frames[1].body_range()], b"one");
        assert_eq!(idx.frames[2].header.flags, FLAG_HAS_ERROR);
    }

    #[test]
    fn rejects_bad_files() {
        assert_eq!(index(b"RPL"), Err(RplError::Short));
        assert_eq!(index(&[0u8; 30]), Err(RplError::BadMagic));
        let mut h = encode_header(&[0; 16]);
        h[4] = 9;
        assert_eq!(index(&h), Err(RplError::Version(9)));
    }
}
