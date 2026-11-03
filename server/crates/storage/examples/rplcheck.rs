//! Crash-test checker: indexes every `.rpl` under a data dir and compares with an ack log
//! (`sid seq ack_ms` per line). Prints JSON: files, frames, missing acks and the oldest missing ack age
//! relative to `--kill-ms`.
//!
//! cargo run --release -p replayd-storage --example rplcheck -- <data_dir> <ack_log> <kill_ms>

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use replayd_common::{rpl, wire};

fn walk(p: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rpl") {
                out.push(p);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (dir, log, kill_ms) = (&args[1], &args[2], args[3].parse::<i64>().unwrap());
    let mut files = vec![];
    walk(Path::new(dir), &mut files);
    let mut present: HashSet<(String, u32)> = HashSet::new();
    let (mut frames, mut bad_files, mut bad_bodies, mut truncated) = (0usize, 0usize, 0usize, 0usize);
    for f in &files {
        let buf = std::fs::read(f).unwrap();
        match rpl::index(&buf) {
            Ok(idx) => {
                if idx.valid_len < buf.len() {
                    truncated += 1;
                }
                let sid = uuid::Uuid::from_bytes(idx.sid).to_string();
                for fr in &idx.frames {
                    frames += 1;
                    let body = bytes::Bytes::copy_from_slice(&buf[fr.body_range()]);
                    if wire::parse_stored_body(&body).is_err() {
                        bad_bodies += 1;
                    }
                    present.insert((sid.clone(), fr.header.seq));
                }
            }
            Err(_) => bad_files += 1,
        }
    }
    let mut acked = 0usize;
    let mut missing = vec![];
    for line in std::fs::read_to_string(log).unwrap().lines() {
        let mut it = line.split(' ');
        let (Some(sid), Some(seq), Some(ms)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        acked += 1;
        let (seq, ms): (u32, i64) = (seq.parse().unwrap(), ms.parse().unwrap());
        if !present.contains(&(sid.to_string(), seq)) {
            missing.push(ms);
        }
    }
    let oldest_missing_before_kill_ms = missing.iter().map(|m| kill_ms - m).max();
    println!(
        "{}",
        serde_json::json!({
            "files": files.len(), "frames": frames, "unreadable_files": bad_files, "bad_bodies": bad_bodies,
            "files_with_truncated_tail": truncated, "acked": acked, "missing": missing.len(),
            "oldest_missing_ack_before_kill_ms": oldest_missing_before_kill_ms,
        })
    );
}
