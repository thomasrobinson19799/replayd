//! replayd-pipeline: stack parsing, URL normalization, fingerprinting, issue upsert and event batches (§5.5).

pub mod event;
pub mod fingerprint;
pub mod normalize;
pub mod stack;
pub mod worker;

pub use worker::{IssueSignal, Shared, spawn};
