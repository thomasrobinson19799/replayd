//! replayd-storage: `.rpl` shard writers, session aggregator, replay ingest sink, disk retention.

pub mod aggregator;
pub mod retention;
pub mod sink;
pub mod uploader;
pub mod writer;

pub use sink::StorageSink;
pub use writer::{SealOutcome, WriterConfig, Writers, session_path};
