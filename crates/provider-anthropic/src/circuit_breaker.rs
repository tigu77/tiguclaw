//! Circuit breaker for Anthropic API calls.
//!
//! Opens after `threshold` consecutive failures and blocks requests
//! for `cooldown` duration. Auto-resets (half-open) after cooldown.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Thread-safe circuit breaker backed by atomics.
pub struct CircuitBreaker {
    /// Number of consecutive failures since last success.
    consecutive_failures: AtomicU32,
    /// Failure threshold before opening the circuit.
    threshold: u32,
    /// Cooldown duration in seconds.
    cooldown_secs: u64,
    /// Unix timestamp (ms) when the circuit opened; 0 = closed.
    opened_at_ms: AtomicU64,
}

impl CircuitBreaker {
    /// Create a new circuit breaker.
    ///
    /// `threshold`: consecutive failures before opening (e.g. 3).
    /// `cooldown`: how long to block requests after opening (e.g. 30s).
    pub fn new(threshold: u32, cooldown: Duration) -> Self {
        Self {
            consecutive_failures: AtomicU32::new(0),
            threshold,
            cooldown_secs: cooldown.as_secs(),
            opened_at_ms: AtomicU64::new(0),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Check whether the circuit is open.
    ///
    /// Returns `None` if the circuit is closed (requests allowed).
    /// Returns `Some(remaining)` if the circuit is open with time left in cooldown.
    /// Auto-resets to closed once the cooldown has elapsed (half-open → closed).
    pub fn check(&self) -> Option<Duration> {
        let opened_at = self.opened_at_ms.load(Ordering::Relaxed);
        if opened_at == 0 {
            return None;
        }

        let elapsed_ms = Self::now_ms().saturating_sub(opened_at);
        let cooldown_ms = self.cooldown_secs * 1000;

        if elapsed_ms >= cooldown_ms {
            // Cooldown elapsed — reset and let this request through.
            self.opened_at_ms.store(0, Ordering::Relaxed);
            self.consecutive_failures.store(0, Ordering::Relaxed);
            None
        } else {
            Some(Duration::from_millis(cooldown_ms - elapsed_ms))
        }
    }

    /// Record a successful API call — resets the failure counter.
    pub fn record_success(&self) {
        self.consecutive_failures.store(0, Ordering::Relaxed);
        self.opened_at_ms.store(0, Ordering::Relaxed);
    }

    /// Record a failed API call — increments the counter and opens the
    /// circuit if the threshold is reached.
    pub fn record_failure(&self) {
        let prev = self.consecutive_failures.fetch_add(1, Ordering::Relaxed);
        if prev + 1 >= self.threshold {
            let now = Self::now_ms();
            // Only set opened_at if not already set (first trip).
            self.opened_at_ms
                .compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed)
                .ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_opens_at_threshold() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(30));
        assert!(cb.check().is_none());

        cb.record_failure();
        cb.record_failure();
        assert!(cb.check().is_none()); // still closed after 2 failures

        cb.record_failure(); // 3rd — opens
        assert!(cb.check().is_some());
    }

    #[test]
    fn test_success_resets() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(30));
        cb.record_failure();
        cb.record_failure();
        cb.record_failure();
        assert!(cb.check().is_some()); // open

        cb.record_success();
        assert!(cb.check().is_none()); // closed again
    }

    #[test]
    fn test_remaining_cooldown() {
        let cb = CircuitBreaker::new(1, Duration::from_secs(30));
        cb.record_failure();
        let remaining = cb.check().expect("should be open");
        // remaining should be close to 30s
        assert!(remaining.as_secs() >= 29 && remaining.as_secs() <= 30);
    }
}
