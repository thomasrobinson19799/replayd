//! Sharded `.rpl` writers (PRD §5.3).
//!
//! * One OS thread per shard (`hash(sid) % shards`), fed by a **bounded** `sync_channel`; the ingest handler
//!   only does `try_send` and answers `503 Retry-After` when the shard is full.
//! * Files are opened `O_APPEND`; a per-shard LRU keeps ≤ `max_open` descriptors, closing ones idle > 60 s.
//! * Group `fdatasync` once per second for every file written since the last sync (≤ 1 s loss on power
//!   failure; a process crash loses only what is still queued).
//! * Dedup by `seq` with an in-memory bitset per active session.
//! * Payload bytes are written verbatim — never decompressed or re-encoded (AGENTS.md rule 5).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{IoSlice, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bytes::Bytes;
use replayd_common::rpl::{self, FrameHeader};
use uuid::Uuid;

/// One validated segment ready to be appended.
#[derive(Debug)]
pub struct Segment {
    pub project_id: i32,
    pub sid: Uuid,
    /// UTC day of session start (`YYYY-MM-DD`), derived from the UUIDv7 sid.
    pub day: String,
    pub header: FrameHeader,
    /// Body without meta (events + assets section).
    pub body: Bytes,
}

/// Result of a write, forwarded to the session aggregator.
#[derive(Debug)]
pub struct Written {
    pub project_id: i32,
    pub sid: Uuid,
    pub seq: u32,
    pub bytes: u64,
    pub duplicate: bool,
}

#[derive(Debug, Clone)]
pub struct WriterConfig {
    pub data_dir: PathBuf,
    pub shards: usize,
    pub queue_per_shard: usize,
    pub max_open: usize,
    pub idle_close: Duration,
    pub fsync_every: Duration,
}

impl WriterConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        Self {
            data_dir,
            shards: cores,
            queue_per_shard: 512,
            max_open: 2_000,
            idle_close: Duration::from_secs(60),
            fsync_every: Duration::from_secs(1),
        }
    }
}

enum Msg {
    Write(Segment),
    /// Flush + fsync everything, then ack (tests, shutdown).
    Sync(SyncSender<()>),
}

pub struct Writers {
    shards: Vec<SyncSender<Msg>>,
    handles: parking_lot::Mutex<Vec<JoinHandle<()>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SubmitError {
    Full,
    Closed,
}

impl Writers {
    /// Starts the shard threads. `written` receives a record per segment (bounded; dropped if full).
    pub fn start(
        cfg: WriterConfig,
        written: Option<tokio::sync::mpsc::Sender<Written>>,
    ) -> std::io::Result<Arc<Self>> {
        std::fs::create_dir_all(&cfg.data_dir)?;
        let mut shards = Vec::with_capacity(cfg.shards);
        let mut handles = Vec::with_capacity(cfg.shards);
        for i in 0..cfg.shards.max(1) {
            let (tx, rx) = sync_channel::<Msg>(cfg.queue_per_shard);
            let cfg = cfg.clone();
            let written = written.clone();
            let h = std::thread::Builder::new()
                .name(format!("rpl-writer-{i}"))
                .spawn(move || Shard::new(cfg, written).run(rx))?;
            shards.push(tx);
            handles.push(h);
        }
        Ok(Arc::new(Self {
            shards,
            handles: parking_lot::Mutex::new(handles),
        }))
    }

    fn shard_of(&self, sid: &Uuid) -> usize {
        let (a, b) = sid.as_u64_pair();
        ((a ^ b.rotate_left(17)) % self.shards.len() as u64) as usize
    }

    /// Non-blocking enqueue (called from the ingest handler).
    pub fn submit(&self, seg: Segment) -> Result<(), SubmitError> {
        let i = self.shard_of(&seg.sid);
        match self.shards[i].try_send(Msg::Write(seg)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(SubmitError::Full),
            Err(TrySendError::Disconnected(_)) => Err(SubmitError::Closed),
        }
    }

    /// Blocks until every shard has written and fsynced everything queued before this call.
    pub fn sync_all(&self) {
        let acks: Vec<_> = self
            .shards
            .iter()
            .filter_map(|s| {
                let (tx, rx) = sync_channel(1);
                s.send(Msg::Sync(tx)).ok().map(|_| rx)
            })
            .collect();
        for a in acks {
            let _ = a.recv();
        }
    }

    /// Total queued messages (gauge `replayd_queue_depth{queue="replay"}` is approximate).
    pub fn shard_count(&self) -> usize {
        self.shards.len()
    }

    /// Stops accepting, drains queues, fsyncs and joins the threads.
    pub fn shutdown(self: &Arc<Self>) {
        self.sync_all();
        // Dropping senders is not possible through the Arc; threads exit when the process does.
        // Explicit join only when we are the last owner.
        if Arc::strong_count(self) == 1 {
            for h in self.handles.lock().drain(..) {
                let _ = h.join();
            }
        }
    }
}

pub fn session_path(data_dir: &Path, project_id: i32, day: &str, sid: &Uuid) -> PathBuf {
    data_dir
        .join(project_id.to_string())
        .join(day)
        .join(format!("{}.rpl", sid.as_hyphenated()))
}

struct OpenFile {
    file: File,
    last_used: Instant,
    dirty: bool,
}

struct SessionSeqs {
    bits: Vec<u64>,
    last_seen: Instant,
}

/// Max seq tracked by the dedup bitset (a 60-min session at 1 segment / 5 s is ~720; flushes on errors add
/// a few). Higher seqs are accepted without dedup.
const MAX_SEQ_TRACKED: u32 = 16_384;

impl SessionSeqs {
    /// Returns true if `seq` was already written.
    fn test_and_set(&mut self, seq: u32) -> bool {
        if seq >= MAX_SEQ_TRACKED {
            return false;
        }
        let (w, b) = ((seq / 64) as usize, seq % 64);
        if self.bits.len() <= w {
            self.bits.resize(w + 1, 0);
        }
        let was = self.bits[w] & (1 << b) != 0;
        self.bits[w] |= 1 << b;
        was
    }
}

struct Shard {
    cfg: WriterConfig,
    files: HashMap<Uuid, OpenFile>,
    seqs: HashMap<Uuid, SessionSeqs>,
    written: Option<tokio::sync::mpsc::Sender<Written>>,
    last_sync: Instant,
    last_sweep: Instant,
}

impl Shard {
    fn new(cfg: WriterConfig, written: Option<tokio::sync::mpsc::Sender<Written>>) -> Self {
        Self {
            cfg,
            files: HashMap::new(),
            seqs: HashMap::new(),
            written,
            last_sync: Instant::now(),
            last_sweep: Instant::now(),
        }
    }

    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            let timeout = self.cfg.fsync_every.saturating_sub(self.last_sync.elapsed());
            match rx.recv_timeout(timeout.max(Duration::from_millis(1))) {
                Ok(Msg::Write(seg)) => self.write(seg),
                Ok(Msg::Sync(ack)) => {
                    // everything queued before the Sync message has been processed (FIFO)
                    self.sync();
                    let _ = ack.send(());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.sync();
                    return;
                }
            }
            if self.last_sync.elapsed() >= self.cfg.fsync_every {
                self.sync();
            }
            if self.last_sweep.elapsed() >= Duration::from_secs(10) {
                self.sweep();
            }
        }
    }

    fn sync(&mut self) {
        let started = Instant::now();
        let mut n = 0;
        for f in self.files.values_mut().filter(|f| f.dirty) {
            if let Err(e) = f.file.sync_data() {
                tracing::error!(error = %e, "fdatasync failed");
            }
            f.dirty = false;
            n += 1;
        }
        if n > 0 {
            metrics::histogram!("replayd_writer_fsync_seconds").record(started.elapsed().as_secs_f64());
        }
        self.last_sync = Instant::now();
    }

    fn sweep(&mut self) {
        let idle = self.cfg.idle_close;
        let before = self.files.len();
        self.files.retain(|_, f| f.dirty || f.last_used.elapsed() < idle);
        // dedup state lives a bit longer than the fd (late retries after a pause)
        self.seqs
            .retain(|_, s| s.last_seen.elapsed() < Duration::from_secs(20 * 60));
        if self.files.len() != before {
            metrics::gauge!("replayd_open_files").decrement((before - self.files.len()) as f64);
        }
        self.last_sweep = Instant::now();
    }

    fn evict_lru(&mut self) {
        if self.files.len() < self.cfg.max_open {
            return;
        }
        if let Some(sid) = self
            .files
            .iter()
            .min_by_key(|(_, f)| f.last_used)
            .map(|(k, _)| *k)
        {
            if let Some(mut f) = self.files.remove(&sid)
                && f.dirty
            {
                let _ = f.file.sync_data();
                f.dirty = false;
            }
            metrics::gauge!("replayd_open_files").decrement(1.0);
        }
    }

    fn open(&mut self, seg: &Segment) -> std::io::Result<&mut OpenFile> {
        if !self.files.contains_key(&seg.sid) {
            self.evict_lru();
            let path = session_path(&self.cfg.data_dir, seg.project_id, &seg.day, &seg.sid);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
            if file.metadata()?.len() == 0 {
                file.write_all(&rpl::encode_header(seg.sid.as_bytes()))?;
            }
            self.files.insert(
                seg.sid,
                OpenFile {
                    file,
                    last_used: Instant::now(),
                    dirty: true,
                },
            );
            metrics::gauge!("replayd_open_files").increment(1.0);
        }
        Ok(self.files.get_mut(&seg.sid).expect("just inserted"))
    }

    fn write(&mut self, seg: Segment) {
        let dup = self.seqs.entry(seg.sid).or_insert_with(|| SessionSeqs {
            bits: Vec::new(),
            last_seen: Instant::now(),
        });
        dup.last_seen = Instant::now();
        let duplicate = dup.test_and_set(seg.header.seq);
        if !duplicate {
            let hdr = seg.header.encode();
            let res = self.open(&seg).and_then(|f| {
                write_all_vectored(&mut f.file, &hdr, &seg.body)?;
                f.dirty = true;
                f.last_used = Instant::now();
                Ok(())
            });
            if let Err(e) = res {
                tracing::error!(error = %e, project = seg.project_id, "rpl append failed");
                metrics::counter!("replayd_writer_errors_total").increment(1);
                return;
            }
        }
        if let Some(tx) = &self.written {
            let w = Written {
                project_id: seg.project_id,
                sid: seg.sid,
                seq: seg.header.seq,
                bytes: (rpl::FRAME_HEADER_LEN + seg.body.len()) as u64,
                duplicate,
            };
            if tx.try_send(w).is_err() {
                metrics::counter!("replayd_queue_rejected_total", "queue" => "written").increment(1);
            }
        }
    }
}

/// One `writev` for header + body (a single append keeps frames contiguous under O_APPEND).
fn write_all_vectored(f: &mut File, hdr: &[u8], body: &[u8]) -> std::io::Result<()> {
    let total = hdr.len() + body.len();
    let n = f.write_vectored(&[IoSlice::new(hdr), IoSlice::new(body)])?;
    if n == total {
        return Ok(());
    }
    // short write (rare): finish sequentially
    if n < hdr.len() {
        f.write_all(&hdr[n..])?;
        f.write_all(body)
    } else {
        f.write_all(&body[n - hdr.len()..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(sid: Uuid, seq: u32, body: &'static [u8]) -> Segment {
        Segment {
            project_id: 7,
            sid,
            day: "2026-11-03".into(),
            header: FrameHeader {
                len: body.len() as u32,
                seq,
                t0: 1,
                t1: 2,
                received_at: 3,
                flags: 0,
            },
            body: Bytes::from_static(body),
        }
    }

    #[test]
    fn writes_dedups_and_indexes() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = WriterConfig::new(dir.path().to_path_buf());
        cfg.shards = 2;
        let (wtx, mut wrx) = tokio::sync::mpsc::channel(64);
        let w = Writers::start(cfg, Some(wtx)).unwrap();
        let sid = Uuid::now_v7();
        for (seq, body) in [(1, &b"one"[..]), (0, b"zero"), (1, b"dup"), (2, b"two")] {
            w.submit(seg(sid, seq, body)).unwrap();
        }
        w.sync_all();
        let path = session_path(dir.path(), 7, "2026-11-03", &sid);
        let buf = std::fs::read(&path).unwrap();
        let idx = rpl::index(&buf).unwrap();
        assert_eq!(
            idx.frames.iter().map(|f| f.header.seq).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(idx.duplicates, 0, "duplicate never reached the disk");
        assert_eq!(&buf[idx.frames[1].body_range()], b"one");
        let mut dups = 0;
        while let Ok(x) = wrx.try_recv() {
            dups += x.duplicate as u32;
        }
        assert_eq!(dups, 1);
    }

    #[test]
    fn bounded_queue_rejects_when_full_and_lru_caps_fds() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = WriterConfig::new(dir.path().to_path_buf());
        cfg.shards = 1;
        cfg.queue_per_shard = 1;
        cfg.max_open = 3;
        let w = Writers::start(cfg, None).unwrap();
        let mut full = 0;
        for i in 0..2000u32 {
            if w.submit(seg(Uuid::now_v7(), i, b"x")) == Err(SubmitError::Full) {
                full += 1;
            }
        }
        assert!(full > 0, "bounded queue must push back");
        w.sync_all();
        // all files that were accepted are readable even though only 3 fds stay open
        let mut files = 0;
        for e in walk(dir.path()) {
            rpl::index(&std::fs::read(e).unwrap()).unwrap();
            files += 1;
        }
        assert_eq!(files, 2000 - full);
    }

    fn walk(p: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in std::fs::read_dir(p).unwrap() {
            let e = e.unwrap().path();
            if e.is_dir() {
                out.extend(walk(&e));
            } else {
                out.push(e);
            }
        }
        out
    }
}
