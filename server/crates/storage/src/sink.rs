//! `ReplaySink` used by `POST /ingest/:pid/replay`: parse meta (O(meta), payload only sliced), derive the
//! file day, enqueue to the shard writer, forward meta to the session aggregator. Never blocks.

use std::sync::Arc;

use bytes::Bytes;
use replayd_common::ids;
use replayd_common::rpl::{FLAG_GAP, FLAG_HAS_ERROR, FrameHeader};
use replayd_common::wire;
use replayd_ingest::{Project, ReplayReject, ReplaySink};
use tokio::sync::mpsc;

use crate::aggregator::{SegmentInfo, utc_day};
use crate::writer::{Segment, SubmitError, Writers};

/// Accept session starts at most this far from the receive time (protects the directory layout and
/// partitions from bogus clocks / sids).
const MAX_START_SKEW_MS: i64 = 2 * 86_400_000;

pub struct StorageSink {
    pub writers: Arc<Writers>,
    pub sessions: mpsc::Sender<SegmentInfo>,
}

impl ReplaySink for StorageSink {
    fn submit(&self, project: &Project, body: Bytes, received_ms: u64) -> Result<(), ReplayReject> {
        let seg = wire::parse_replay_body(&body).map_err(|_| ReplayReject::Invalid("bad segment"))?;
        let sid = ids::parse_sid(&seg.meta.sid).ok_or(ReplayReject::Invalid("bad sid"))?;
        let rcv = received_ms as i64;
        // session start: UUIDv7 timestamp of the sid (SDK creates it at session start)
        let started_ms = ids::uuid_v7_millis(&sid)
            .map(|m| m as i64)
            .filter(|m| (m - rcv).abs() <= MAX_START_SKEW_MS)
            .unwrap_or(rcv);
        let day = utc_day(started_ms);
        let mut flags = 0;
        if seg.meta.gap {
            flags |= FLAG_GAP;
        }
        if seg.meta.has_error {
            flags |= FLAG_HAS_ERROR;
        }
        let header = FrameHeader {
            len: seg.body.len() as u32,
            seq: seg.meta.seq,
            t0: seg.meta.t0,
            t1: seg.meta.t1,
            received_at: (received_ms / 1000) as u32,
            flags,
        };
        let bytes = seg.body.len() as u64;
        self.writers
            .submit(Segment {
                project_id: project.row.id,
                sid,
                day: day.clone(),
                header,
                body: seg.body,
            })
            .map_err(|e| match e {
                SubmitError::Full | SubmitError::Closed => ReplayReject::Busy,
            })?;
        let info = SegmentInfo {
            project_id: project.row.id,
            sid,
            started_ms,
            file_day: day,
            meta: seg.meta,
            bytes,
        };
        if self.sessions.try_send(info).is_err() {
            metrics::counter!("replayd_queue_rejected_total", "queue" => "sessions").increment(1);
        }
        Ok(())
    }
}
