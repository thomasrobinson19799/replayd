//! replayd-storage: `.rpl` shard writers, session aggregator, replay ingest sink, disk retention.

pub mod aggregator;
pub mod sink;
pub mod writer;

pub use sink::StorageSink;
pub use writer::{WriterConfig, Writers, session_path};
