//! Lightweight cancellation token for cooperative task cancellation.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A cloneable token that signals cancellation to cooperative tasks.
#[derive(Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Create a new token (not cancelled).
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Signal cancellation.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    /// Check whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_token_not_cancelled() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());
    }

    #[test]
    fn test_cancel() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn test_clone_shares_state() {
        let token = CancellationToken::new();
        let cloned = token.clone();
        token.cancel();
        assert!(cloned.is_cancelled());
    }

    #[test]
    fn test_default() {
        let token = CancellationToken::default();
        assert!(!token.is_cancelled());
    }
}
