//! Token buckets: one per project, one per client IP (bounded, sharded, idle entries swept).

use std::collections::HashMap;
use std::hash::{BuildHasher, Hash};
use std::net::IpAddr;
use std::time::Instant;

use parking_lot::Mutex;

#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    tokens: f64,
    last: Instant,
}

impl Bucket {
    pub fn new(burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            last: now,
        }
    }

    /// Takes one token; returns `Err(seconds until a token is available)` when empty.
    pub fn take(&mut self, rate: f64, burst: f64, now: Instant) -> Result<(), u64> {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * rate).min(burst);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            let wait = if rate > 0.0 {
                (1.0 - self.tokens) / rate
            } else {
                60.0
            };
            Err(wait.ceil().max(1.0) as u64)
        }
    }
}

const SHARDS: usize = 32;

/// Sharded bucket map with a hard cap on entries (memory stays bounded under IP floods).
pub struct BucketMap<K> {
    shards: Vec<Mutex<HashMap<K, Bucket>>>,
    hasher: std::hash::RandomState,
    cap_per_shard: usize,
}

impl<K: Hash + Eq + Copy> BucketMap<K> {
    pub fn new(max_entries: usize) -> Self {
        Self {
            shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
            hasher: std::hash::RandomState::new(),
            cap_per_shard: max_entries.div_ceil(SHARDS).max(1),
        }
    }

    pub fn take(&self, key: K, rate: f64, burst: f64, now: Instant) -> Result<(), u64> {
        let shard = &self.shards[(self.hasher.hash_one(key) as usize) % SHARDS];
        let mut m = shard.lock();
        if let Some(b) = m.get_mut(&key) {
            return b.take(rate, burst, now);
        }
        if m.len() >= self.cap_per_shard {
            // Full: evict buckets that are back to full (idle) to make room; if none, fail open
            // for this key rather than growing without bound (per-project bucket still applies).
            let full_after = (burst / rate.max(f64::MIN_POSITIVE)).max(1.0);
            m.retain(|_, b| now.saturating_duration_since(b.last).as_secs_f64() < full_after);
            if m.len() >= self.cap_per_shard {
                return Ok(());
            }
        }
        let mut b = Bucket::new(burst, now);
        let r = b.take(rate, burst, now);
        m.insert(key, b);
        r
    }

    /// Drops entries idle for longer than `idle_secs` (they would be full again anyway).
    pub fn sweep(&self, idle_secs: f64, now: Instant) {
        for s in &self.shards {
            s.lock()
                .retain(|_, b| now.saturating_duration_since(b.last).as_secs_f64() < idle_secs);
        }
    }

    pub fn len(&self) -> usize {
        self.shards.iter().map(|s| s.lock().len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub struct Limits {
    pub projects: BucketMap<i32>,
    pub ips: BucketMap<IpAddr>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bucket_refills() {
        let t0 = Instant::now();
        let mut b = Bucket::new(2.0, t0);
        assert!(b.take(1.0, 2.0, t0).is_ok());
        assert!(b.take(1.0, 2.0, t0).is_ok());
        assert_eq!(b.take(1.0, 2.0, t0), Err(1));
        assert!(b.take(1.0, 2.0, t0 + Duration::from_millis(1100)).is_ok());
    }

    #[test]
    fn map_is_bounded() {
        let m: BucketMap<u32> = BucketMap::new(64);
        let now = Instant::now();
        for i in 0..10_000 {
            let _ = m.take(i, 1.0, 5.0, now);
        }
        assert!(m.len() <= 64 + SHARDS);
        m.sweep(0.0, now + Duration::from_secs(1));
        assert!(m.is_empty());
    }
}
