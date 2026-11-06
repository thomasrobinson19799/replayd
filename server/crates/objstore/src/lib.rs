//! Bucket tier for finished `.rpl` recordings (D-37).
//!
//! Live sessions stay in `data/<pid>/<day>/<sid>.rpl`: buckets cannot append, and the writers' ≤ 1 s crash-loss
//! guarantee needs a real disk. Finished recordings move to `replays/<pid>/<day>/<sid>.rpl` in the bucket.
//!
//! * Every key lives under [`PREFIX`]; nothing outside it is ever listed or deleted, so a bucket shared with
//!   another application cannot lose that application's objects.
//! * A segment that arrives after the upload (an APK draining its offline queue) starts a new local file.
//!   The next upload merges it into the object, dropping `seq`s the object already has.
//! * Reads go through `data/_cache/`, so `Range`, `ETag` and viewer redaction keep working on plain files.
//!   The cache is bounded by size and age.

use std::collections::HashSet;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use object_store::aws::AmazonS3Builder;
use object_store::buffered::BufWriter;
use object_store::path::Path;
use object_store::{BackoffConfig, ClientOptions, ObjectStore, RetryConfig};
use replayd_common::config::ObjectStorageConfig;
use replayd_common::rpl::{self, FrameHeader};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Root of every key this crate reads, writes, lists or deletes.
pub const PREFIX: &str = "replays";
const CACHE_DIR: &str = "_cache";
const TMP_DIR: &str = ".tmp";
/// Buffered in memory per transfer: bodies up to this size use one PUT, larger ones a multipart upload.
const PART: usize = 8 * 1024 * 1024;
const READ_BUF: usize = 64 * 1024;
const CONCURRENT_FETCHES: usize = 4;
const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const TMP_MAX_AGE: Duration = Duration::from_secs(3600);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("recording not found")]
    NotFound,
    #[error("object store: {0}")]
    Store(#[from] object_store::Error),
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid recording: {0}")]
    Invalid(String),
}

pub struct ReplayStore {
    store: Arc<dyn ObjectStore>,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    cache_max_bytes: u64,
    upload_idle: Duration,
    fetches: Semaphore,
}

impl ReplayStore {
    pub fn new(
        store: Arc<dyn ObjectStore>,
        data_dir: &FsPath,
        cache_max_bytes: u64,
        upload_idle: Duration,
    ) -> Self {
        Self {
            store,
            data_dir: data_dir.to_path_buf(),
            cache_dir: data_dir.join(CACHE_DIR),
            cache_max_bytes,
            upload_idle,
            fetches: Semaphore::new(CONCURRENT_FETCHES),
        }
    }

    pub fn from_config(cfg: &ObjectStorageConfig, data_dir: &FsPath) -> Result<Self, Error> {
        let store = AmazonS3Builder::new()
            .with_endpoint(&cfg.endpoint)
            .with_bucket_name(&cfg.bucket)
            .with_region(&cfg.region)
            .with_access_key_id(&cfg.access_key)
            .with_secret_access_key(&cfg.secret_key)
            .with_virtual_hosted_style_request(false)
            .with_client_options(ClientOptions::new().with_allow_http(cfg.endpoint.starts_with("http://")))
            // a bucket outage must not hold an upload slot or a dashboard request for minutes
            .with_retry(RetryConfig {
                backoff: BackoffConfig::default(),
                max_retries: 3,
                retry_timeout: Duration::from_secs(30),
            })
            .build()?;
        Ok(Self::new(
            Arc::new(store),
            data_dir,
            cfg.cache_max_mb * 1024 * 1024,
            Duration::from_secs(cfg.upload_idle_secs),
        ))
    }

    /// How long a local recording stays untouched before it is uploaded.
    pub fn upload_idle(&self) -> Duration {
        self.upload_idle
    }

    /// Checks credentials and bucket access with one read-only request.
    pub async fn probe(&self) -> Result<(), Error> {
        self.store.list_with_delimiter(Some(&Path::from(PREFIX))).await?;
        Ok(())
    }

    async fn head_size(&self, key: &Path) -> Result<Option<u64>, Error> {
        match self.store.head(key).await {
            Ok(m) => Ok(Some(m.size)),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Makes the object contain everything in `local` and verifies its size. Returns the local length that is
    /// now covered; only the shard writer may remove the file, and only if it still has that length.
    pub async fn upload(&self, project_id: i32, day: &str, sid: &str, local: &FsPath) -> Result<u64, Error> {
        let len = tokio::fs::metadata(local).await?.len();
        if len < rpl::HEADER_LEN as u64 {
            return Ok(len); // created but never written (crash): nothing to keep
        }
        check_header(local)?;
        let key = object_key(project_id, day, sid);
        let expected = match self.head_size(&key).await? {
            None => {
                self.put_file(&key, local, len).await?;
                len
            }
            Some(size) => {
                let tmp = self.tmp_path().await?;
                let merged = self.merge_upload(&key, size, local, &tmp).await;
                let _ = tokio::fs::remove_file(&tmp).await;
                merged?
            }
        };
        match self.head_size(&key).await? {
            Some(size) if size == expected => Ok(len),
            size => Err(Error::Invalid(format!(
                "object has {size:?} bytes after upload, expected {expected}"
            ))),
        }
    }

    /// Object + new local frames → object. Returns the object's resulting size.
    async fn merge_upload(&self, key: &Path, size: u64, local: &FsPath, tmp: &FsPath) -> Result<u64, Error> {
        self.download(key, size, tmp).await?;
        let (dst, tail) = (tmp.to_path_buf(), local.to_path_buf());
        let outcome = tokio::task::spawn_blocking(move || merge_tail(&dst, &tail))
            .await
            .map_err(std::io::Error::other)??;
        if outcome.added > 0 || outcome.len != size {
            self.put_file(key, tmp, outcome.len).await?;
        }
        Ok(outcome.len)
    }

    /// Streams the first `len` bytes of a file into `key` (visible atomically on completion).
    async fn put_file(&self, key: &Path, path: &FsPath, len: u64) -> Result<(), Error> {
        let file = tokio::fs::File::open(path).await?;
        let mut src = tokio::io::BufReader::with_capacity(READ_BUF, file.take(len));
        let mut dst = BufWriter::with_capacity(self.store.clone(), key.clone(), PART);
        let copied = async {
            loop {
                let chunk = src.fill_buf().await?;
                if chunk.is_empty() {
                    break;
                }
                let n = chunk.len();
                dst.write_all(chunk).await?;
                src.consume(n);
            }
            dst.shutdown().await
        }
        .await;
        if let Err(e) = copied {
            let _ = dst.abort().await;
            return Err(e.into());
        }
        Ok(())
    }

    async fn download(&self, key: &Path, size: u64, dst: &FsPath) -> Result<(), Error> {
        let mut stream = self.store.get(key).await?.into_stream();
        let mut file = tokio::fs::File::create(dst).await?;
        let mut got = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            got += chunk.len() as u64;
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        if got != size {
            return Err(Error::Invalid(format!("downloaded {got} bytes, expected {size}")));
        }
        Ok(())
    }

    async fn tmp_path(&self) -> Result<PathBuf, Error> {
        let dir = self.cache_dir.join(TMP_DIR);
        tokio::fs::create_dir_all(&dir).await?;
        Ok(dir.join(Uuid::now_v7().to_string()))
    }

    /// Plain local file holding the complete recording: the local file if nothing was uploaded yet, otherwise a
    /// cached copy of the object plus any newer local frames. A bucket outage still serves what is on disk.
    pub async fn materialize(&self, project_id: i32, day: &str, sid: &str) -> Result<PathBuf, Error> {
        let local = rpl::recording_path(&self.data_dir, project_id, day, sid);
        let tail = tokio::fs::metadata(&local).await.ok().map(|m| m.len());
        let key = object_key(project_id, day, sid);
        let size = match (self.head_size(&key).await, tail) {
            (Ok(Some(size)), _) => size,
            (Ok(None), Some(_)) | (Err(_), Some(_)) => return Ok(local),
            (Ok(None), None) => return Err(Error::NotFound),
            (Err(e), None) => return Err(e),
        };
        let name = match tail {
            Some(t) => format!("{sid}.{size}.{t}.rpl"),
            None => format!("{sid}.{size}.rpl"),
        };
        let dir = self.cache_dir.join(project_id.to_string()).join(day);
        let cached = dir.join(name);
        if tokio::fs::try_exists(&cached).await? {
            return Ok(cached);
        }
        let _permit = self.fetches.acquire().await.map_err(std::io::Error::other)?;
        if tokio::fs::try_exists(&cached).await? {
            return Ok(cached);
        }
        let tmp = self.tmp_path().await?;
        let built = async {
            self.download(&key, size, &tmp).await?;
            if tail.is_some() {
                let (dst, src) = (tmp.clone(), local.clone());
                tokio::task::spawn_blocking(move || merge_tail(&dst, &src))
                    .await
                    .map_err(std::io::Error::other)??;
            }
            tokio::fs::create_dir_all(&dir).await?;
            tokio::fs::rename(&tmp, &cached).await?;
            Ok::<_, Error>(())
        }
        .await;
        if built.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
        }
        built?;
        Ok(cached)
    }

    /// Removes the object and every cached copy of one session (the local file is the caller's).
    pub async fn delete_session(&self, project_id: i32, day: &str, sid: &str) -> Result<(), Error> {
        match self.store.delete(&object_key(project_id, day, sid)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => return Err(e.into()),
        }
        let dir = self.cache_dir.join(project_id.to_string()).join(day);
        let prefix = format!("{sid}.");
        tokio::task::spawn_blocking(move || {
            for d in [dir.clone(), dir.join(".redacted")] {
                for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                    if e.file_name().to_string_lossy().starts_with(&prefix) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        })
        .await
        .map_err(std::io::Error::other)?;
        Ok(())
    }

    /// Project ids that have objects.
    pub async fn list_projects(&self) -> Result<Vec<i32>, Error> {
        let listed = self.store.list_with_delimiter(Some(&Path::from(PREFIX))).await?;
        Ok(listed
            .common_prefixes
            .iter()
            .filter_map(|p| p.filename()?.parse().ok())
            .collect())
    }

    /// Day folders of one project.
    pub async fn list_days(&self, project_id: i32) -> Result<Vec<String>, Error> {
        let prefix = Path::from(format!("{PREFIX}/{project_id}"));
        let listed = self.store.list_with_delimiter(Some(&prefix)).await?;
        Ok(listed
            .common_prefixes
            .iter()
            .filter_map(|p| p.filename().map(str::to_string))
            .collect())
    }

    /// Deletes one day, or a whole project when `day` is `None`. Returns the number of objects removed.
    pub async fn delete_prefix(&self, project_id: i32, day: Option<&str>) -> Result<u64, Error> {
        let prefix = match day {
            Some(d) => Path::from(format!("{PREFIX}/{project_id}/{d}")),
            None => Path::from(format!("{PREFIX}/{project_id}")),
        };
        let locations = self
            .store
            .list(Some(&prefix))
            .map(|m| m.map(|m| m.location))
            .boxed();
        let mut deleted = self.store.delete_stream(locations);
        let mut n = 0;
        while let Some(r) = deleted.next().await {
            r?;
            n += 1;
        }
        Ok(n)
    }

    /// Drops temporary files and cached copies past their age, then the oldest copies above the size cap.
    /// Blocking: call from `spawn_blocking`.
    pub fn sweep_cache(&self) {
        let mut files = Vec::new();
        walk_cache(&self.cache_dir, &mut files);
        let tmp_dir = self.cache_dir.join(TMP_DIR);
        let now = SystemTime::now();
        let mut kept = Vec::with_capacity(files.len());
        for f in files {
            let age = now.duration_since(f.modified).unwrap_or_default();
            let max = if f.path.starts_with(&tmp_dir) {
                TMP_MAX_AGE
            } else {
                CACHE_MAX_AGE
            };
            if age >= max {
                let _ = std::fs::remove_file(&f.path);
            } else {
                kept.push(f);
            }
        }
        let mut total: u64 = kept.iter().map(|f| f.len).sum();
        kept.sort_by_key(|f| f.modified);
        for f in kept {
            if total <= self.cache_max_bytes {
                break;
            }
            if std::fs::remove_file(&f.path).is_ok() {
                total = total.saturating_sub(f.len);
            }
        }
        remove_empty_dirs(&self.cache_dir);
    }
}

fn object_key(project_id: i32, day: &str, sid: &str) -> Path {
    Path::from(format!("{PREFIX}/{project_id}/{day}/{sid}.rpl"))
}

struct CacheFile {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
}

fn walk_cache(dir: &FsPath, out: &mut Vec<CacheFile>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            walk_cache(&e.path(), out);
        } else if let Ok(modified) = meta.modified() {
            out.push(CacheFile {
                path: e.path(),
                len: meta.len(),
                modified,
            });
        }
    }
}

fn remove_empty_dirs(dir: &FsPath) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.metadata().is_ok_and(|m| m.is_dir()) {
            remove_empty_dirs(&e.path());
            let _ = std::fs::remove_dir(e.path()); // fails while it still has files
        }
    }
}

fn read_header(r: &mut impl Read) -> Result<[u8; rpl::HEADER_LEN], Error> {
    let mut h = [0u8; rpl::HEADER_LEN];
    r.read_exact(&mut h)?;
    rpl::index(&h).map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(h)
}

fn check_header(path: &FsPath) -> Result<(), Error> {
    read_header(&mut std::fs::File::open(path)?).map(|_| ())
}

struct Merged {
    added: u64,
    len: u64,
}

/// Next complete frame header at the reader's position; `None` at the end or at a truncated/corrupt tail.
fn next_header(r: &mut impl Read) -> std::io::Result<Option<FrameHeader>> {
    let mut b = [0u8; rpl::FRAME_HEADER_LEN];
    match r.read_exact(&mut b) {
        Ok(()) => Ok(FrameHeader::decode(&b).filter(|h| h.len <= rpl::MAX_FRAME_LEN)),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

/// Appends the frames of `tail` whose `seq` is not in `dst` yet (first copy wins, as in readers). A truncated
/// tail of `dst` is cut first: frames appended behind it would be unreadable. Holds one frame in memory.
fn merge_tail(dst: &FsPath, tail: &FsPath) -> Result<Merged, Error> {
    let mut out = std::fs::OpenOptions::new().read(true).write(true).open(dst)?;
    let size = out.metadata()?.len();
    let mut seqs = HashSet::new();
    let (sid, valid) = {
        let mut r = BufReader::with_capacity(READ_BUF, &mut out);
        let sid = read_header(&mut r)?;
        let mut pos = rpl::HEADER_LEN as u64;
        while let Some(h) = next_header(&mut r)? {
            let end = pos + rpl::FRAME_HEADER_LEN as u64 + u64::from(h.len);
            if end > size {
                break;
            }
            seqs.insert(h.seq);
            r.seek_relative(i64::from(h.len))?;
            pos = end;
        }
        (sid, pos)
    };
    out.set_len(valid)?;
    out.seek(SeekFrom::End(0))?;
    let mut merged = Merged { added: 0, len: valid };
    let src = match std::fs::File::open(tail) {
        Ok(f) => f,
        // uploaded and removed since the caller looked: the object already has it
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(merged),
        Err(e) => return Err(e.into()),
    };
    let mut r = BufReader::with_capacity(READ_BUF, src);
    if read_header(&mut r)? != sid {
        return Err(Error::Invalid("session id differs from the object".into()));
    }
    let mut body = Vec::new();
    while let Some(h) = next_header(&mut r)? {
        body.resize(h.len as usize, 0);
        match r.read_exact(&mut body) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        }
        if seqs.insert(h.seq) {
            out.write_all(&h.encode())?;
            out.write_all(&body)?;
            merged.added += 1;
            merged.len += (rpl::FRAME_HEADER_LEN + body.len()) as u64;
        }
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::memory::InMemory;
    use object_store::{ObjectStore, PutPayload};

    const SID: &str = "0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d";
    const DAY: &str = "2026-11-06";

    fn frame(seq: u32, body: &[u8]) -> Vec<u8> {
        let mut f = FrameHeader {
            len: body.len() as u32,
            seq,
            t0: 1,
            t1: 2,
            received_at: 3,
            flags: 0,
        }
        .encode()
        .to_vec();
        f.extend_from_slice(body);
        f
    }

    fn sid_bytes() -> [u8; 16] {
        *Uuid::parse_str(SID).unwrap().as_bytes()
    }

    fn recording(frames: &[(u32, &[u8])]) -> Vec<u8> {
        let mut f = rpl::encode_header(&sid_bytes()).to_vec();
        for (seq, body) in frames {
            f.extend(frame(*seq, body));
        }
        f
    }

    fn seqs(buf: &[u8]) -> Vec<(u32, Vec<u8>)> {
        let idx = rpl::index(buf).unwrap();
        idx.frames
            .iter()
            .map(|f| (f.header.seq, buf[f.body_range()].to_vec()))
            .collect()
    }

    struct Fixture {
        dir: tempfile::TempDir,
        mem: Arc<InMemory>,
        store: ReplayStore,
    }

    fn fixture(cache_max: u64) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mem = Arc::new(InMemory::new());
        let store = ReplayStore::new(mem.clone(), dir.path(), cache_max, Duration::from_secs(1));
        Fixture { dir, mem, store }
    }

    impl Fixture {
        fn local(&self) -> PathBuf {
            rpl::recording_path(self.dir.path(), 7, DAY, SID)
        }

        fn write_local(&self, data: &[u8]) -> PathBuf {
            let p = self.local();
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, data).unwrap();
            p
        }

        async fn object(&self) -> Vec<u8> {
            let key = object_key(7, DAY, SID);
            self.mem.get(&key).await.unwrap().bytes().await.unwrap().to_vec()
        }
    }

    #[tokio::test]
    async fn upload_verifies_and_key_is_under_the_prefix() {
        let f = fixture(1 << 20);
        let data = recording(&[(0, b"zero"), (1, b"one")]);
        let p = f.write_local(&data);
        assert_eq!(f.store.upload(7, DAY, SID, &p).await.unwrap(), data.len() as u64);
        assert_eq!(f.object().await, data);
        let keys: Vec<_> = f
            .mem
            .list(None)
            .map(|m| m.unwrap().location.to_string())
            .collect()
            .await;
        assert_eq!(keys, [format!("replays/7/{DAY}/{SID}.rpl")]);
        assert!(p.exists(), "only the shard writer removes local files");
    }

    #[tokio::test]
    async fn large_recording_round_trips_through_multipart() {
        let f = fixture(1 << 30);
        let big = vec![0xAB; 1 << 20];
        let frames: Vec<(u32, &[u8])> = (0..20).map(|i| (i, big.as_slice())).collect();
        let data = recording(&frames);
        assert!(data.len() > PART);
        let p = f.write_local(&data);
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        std::fs::remove_file(&p).unwrap();
        let got = f.store.materialize(7, DAY, SID).await.unwrap();
        assert_eq!(std::fs::read(got).unwrap(), data);
    }

    #[tokio::test]
    async fn late_segment_merges_without_duplicates() {
        let f = fixture(1 << 20);
        let p = f.write_local(&recording(&[(0, b"zero"), (1, b"one")]));
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        // a retry of seq 1 and a new seq 2 after the local file was removed
        let p = f.write_local(&recording(&[(1, b"retry"), (2, b"two")]));
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        assert_eq!(
            seqs(&f.object().await),
            [(0, b"zero".to_vec()), (1, b"one".to_vec()), (2, b"two".to_vec())]
        );
    }

    #[tokio::test]
    async fn merge_cuts_a_truncated_object_tail() {
        let f = fixture(1 << 20);
        let mut torn = recording(&[(0, b"zero")]);
        torn.extend(&frame(1, b"partial")[..10]);
        let p = f.write_local(&torn);
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        let p = f.write_local(&recording(&[(1, b"one")]));
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        assert_eq!(
            seqs(&f.object().await),
            [(0, b"zero".to_vec()), (1, b"one".to_vec())]
        );
    }

    #[tokio::test]
    async fn merge_with_nothing_new_keeps_the_object() {
        let f = fixture(1 << 20);
        let data = recording(&[(0, b"zero")]);
        let p = f.write_local(&data);
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        let before = f.mem.head(&object_key(7, DAY, SID)).await.unwrap().e_tag;
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        assert_eq!(f.mem.head(&object_key(7, DAY, SID)).await.unwrap().e_tag, before);
    }

    #[tokio::test]
    async fn foreign_or_empty_local_files_are_not_uploaded() {
        let f = fixture(1 << 20);
        let p = f.write_local(b"");
        assert_eq!(f.store.upload(7, DAY, SID, &p).await.unwrap(), 0);
        let p = f.write_local(&[b'x'; 64]);
        assert!(matches!(
            f.store.upload(7, DAY, SID, &p).await,
            Err(Error::Invalid(_))
        ));
        assert!(f.mem.head(&object_key(7, DAY, SID)).await.is_err());
    }

    #[tokio::test]
    async fn merge_refuses_another_sessions_file() {
        let f = fixture(1 << 20);
        let p = f.write_local(&recording(&[(0, b"zero")]));
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        let mut other = rpl::encode_header(&[9u8; 16]).to_vec();
        other.extend(frame(1, b"one"));
        let p = f.write_local(&other);
        assert!(matches!(
            f.store.upload(7, DAY, SID, &p).await,
            Err(Error::Invalid(_))
        ));
        assert_eq!(seqs(&f.object().await).len(), 1);
    }

    #[tokio::test]
    async fn materialize_prefers_local_then_object_then_stitches() {
        let f = fixture(1 << 20);
        assert!(matches!(
            f.store.materialize(7, DAY, SID).await,
            Err(Error::NotFound)
        ));

        let data = recording(&[(0, b"zero")]);
        let p = f.write_local(&data);
        assert_eq!(f.store.materialize(7, DAY, SID).await.unwrap(), p);

        f.store.upload(7, DAY, SID, &p).await.unwrap();
        std::fs::remove_file(&p).unwrap();
        let cached = f.store.materialize(7, DAY, SID).await.unwrap();
        assert!(cached.starts_with(f.dir.path().join(CACHE_DIR)));
        assert_eq!(std::fs::read(&cached).unwrap(), data);
        // second read: no download, same file
        f.mem.delete(&object_key(7, DAY, SID)).await.ok();
        f.mem
            .put(&object_key(7, DAY, SID), PutPayload::from(data.clone()))
            .await
            .unwrap();
        assert_eq!(f.store.materialize(7, DAY, SID).await.unwrap(), cached);

        // a late segment is visible before its upload
        f.write_local(&recording(&[(0, b"retry"), (1, b"one")]));
        let stitched = f.store.materialize(7, DAY, SID).await.unwrap();
        assert_eq!(
            seqs(&std::fs::read(stitched).unwrap()),
            [(0, b"zero".to_vec()), (1, b"one".to_vec())]
        );
    }

    #[tokio::test]
    async fn outage_serves_local_and_reports_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ObjectStorageConfig {
            endpoint: "http://127.0.0.1:1".into(),
            bucket: "b".into(),
            region: "r".into(),
            access_key: "k".into(),
            secret_key: "s".into(),
            upload_idle_secs: 1,
            cache_max_mb: 1,
        };
        let store = ReplayStore::from_config(&cfg, dir.path()).unwrap();
        assert!(matches!(
            store.materialize(7, DAY, SID).await,
            Err(Error::Store(_))
        ));
        assert!(store.probe().await.is_err());
        let p = rpl::recording_path(dir.path(), 7, DAY, SID);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, recording(&[(0, b"zero")])).unwrap();
        assert_eq!(store.materialize(7, DAY, SID).await.unwrap(), p);
    }

    #[tokio::test]
    async fn delete_session_removes_object_and_cached_copies() {
        let f = fixture(1 << 20);
        let p = f.write_local(&recording(&[(0, b"zero")]));
        f.store.upload(7, DAY, SID, &p).await.unwrap();
        std::fs::remove_file(&p).unwrap();
        let cached = f.store.materialize(7, DAY, SID).await.unwrap();
        let redacted = cached.parent().unwrap().join(".redacted");
        std::fs::create_dir_all(&redacted).unwrap();
        let copy = redacted.join(format!("{SID}.1.2.rpl"));
        std::fs::write(&copy, b"x").unwrap();
        let other = cached.parent().unwrap().join("other.rpl");
        std::fs::write(&other, b"x").unwrap();

        f.store.delete_session(7, DAY, SID).await.unwrap();
        assert!(f.mem.head(&object_key(7, DAY, SID)).await.is_err());
        assert!(!cached.exists() && !copy.exists());
        assert!(other.exists());
        f.store.delete_session(7, DAY, SID).await.unwrap();
    }

    #[tokio::test]
    async fn listing_and_deleting_never_leave_the_prefix() {
        let f = fixture(1 << 20);
        for k in [
            "20/1/0123/0",
            "1/2026-01-01/foreign.rpl",
            "replays/1/2026-01-01/a.rpl",
            "replays/1/2026-01-02/b.rpl",
            "replays/2/2026-01-01/c.rpl",
            "replays/not-a-project/2026-01-01/d.rpl",
        ] {
            f.mem
                .put(&Path::from(k), PutPayload::from_static(b"x"))
                .await
                .unwrap();
        }
        let mut p = f.store.list_projects().await.unwrap();
        p.sort();
        assert_eq!(p, [1, 2]);
        let mut days = f.store.list_days(1).await.unwrap();
        days.sort();
        assert_eq!(days, ["2026-01-01", "2026-01-02"]);
        assert_eq!(f.store.delete_prefix(1, Some("2026-01-01")).await.unwrap(), 1);
        assert_eq!(f.store.delete_prefix(2, None).await.unwrap(), 1);
        let mut left: Vec<_> = f
            .mem
            .list(None)
            .map(|m| m.unwrap().location.to_string())
            .collect()
            .await;
        left.sort();
        assert_eq!(
            left,
            [
                "1/2026-01-01/foreign.rpl",
                "20/1/0123/0",
                "replays/1/2026-01-02/b.rpl",
                "replays/not-a-project/2026-01-01/d.rpl",
            ]
        );
    }

    #[test]
    fn sweep_enforces_age_and_size() {
        let f = fixture(10);
        let dir = f.dir.path().join(CACHE_DIR).join("7").join(DAY);
        std::fs::create_dir_all(&dir).unwrap();
        let tmp_dir = f.dir.path().join(CACHE_DIR).join(TMP_DIR);
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let now = SystemTime::now();
        let write = |p: PathBuf, len: usize, age: u64| {
            let file = std::fs::File::create(&p).unwrap();
            file.set_len(len as u64).unwrap();
            file.set_modified(now - Duration::from_secs(age)).unwrap();
            p
        };
        let expired = write(dir.join("expired.rpl"), 1, CACHE_MAX_AGE.as_secs() + 1);
        let stale_tmp = write(tmp_dir.join("stale"), 1, TMP_MAX_AGE.as_secs() + 1);
        let fresh_tmp = write(tmp_dir.join("fresh"), 1, 5);
        let oldest = write(dir.join("oldest.rpl"), 8, 300);
        let newest = write(dir.join("newest.rpl"), 8, 100);
        f.store.sweep_cache();
        assert!(!expired.exists() && !stale_tmp.exists());
        assert!(!oldest.exists(), "oldest copy goes first above the size cap");
        assert!(newest.exists() && fresh_tmp.exists());

        std::fs::remove_file(newest).unwrap();
        f.store.sweep_cache();
        assert!(!dir.exists(), "empty day folders are removed");
    }
}
