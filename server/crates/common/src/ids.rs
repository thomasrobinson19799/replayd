//! Identifier helpers. Session ids are client-generated UUIDv7 strings (PRD §4.5).

pub use uuid::Uuid;

/// Parses a session id; accepts any RFC 4122 UUID text form (the SDK sends hyphenated lowercase).
pub fn parse_sid(s: &str) -> Option<Uuid> {
    if s.len() != 36 {
        return None;
    }
    Uuid::try_parse(s).ok()
}

/// Milliseconds since the Unix epoch encoded in a UUIDv7, if it is one.
pub fn uuid_v7_millis(id: &Uuid) -> Option<u64> {
    if id.get_version_num() != 7 {
        return None;
    }
    let b = id.as_bytes();
    Some(u64::from_be_bytes([0, 0, b[0], b[1], b[2], b[3], b[4], b[5]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v7() {
        let id = parse_sid("0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d").unwrap();
        assert_eq!(uuid_v7_millis(&id), Some(0x0192_f0c4_7a3e));
        assert!(parse_sid("0192f0c47a3e7b1a9c2d3e4f5a6b7c8d").is_none());
        assert!(parse_sid("zz92f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d").is_none());
    }
}
