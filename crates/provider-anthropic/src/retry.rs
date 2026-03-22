//! Retry helpers for Anthropic API errors.
//!
//! Matches Anthropic's official SDK retry policy:
//! status codes 408, 409, 429, 500–599 are considered transient
//! and eligible for retry with exponential backoff.

use std::time::Duration;
use tiguclaw_core::error::TiguError;

/// Returns true if the error is transient and the request should be retried.
///
/// Covers:
/// - 429 rate limited  
/// - 529 overloaded
/// - 408 / 409 (timeout / conflict)
/// - 5xx server errors
/// - Network / connection failures
/// - SSE stream read errors
/// - Chunk streaming timeouts
pub fn is_retryable(e: &TiguError) -> bool {
    match e {
        TiguError::Provider(msg) => {
            // HTTP status-based
            if msg.contains("rate limited") {
                return true; // 429
            }
            if msg.contains("overloaded") {
                return true; // 529
            }
            // "API error ({status}, ...)" format
            if msg.contains("API error (408") || msg.contains("API error (409") {
                return true;
            }
            // 5xx: "API error (5XX, ...)"
            if is_api_5xx(msg) {
                return true;
            }
            // Network / stream errors
            if msg.contains("request failed")
                || msg.contains("stream read error")
                || msg.contains("타임아웃")
                || msg.contains("SSE error")
            {
                return true;
            }
            false
        }
        TiguError::Timeout(_) => true,
        _ => false,
    }
}

/// Checks whether the message encodes an HTTP 5xx API error.
/// Format produced by anthropic.rs: `"API error ({status}, {type}): {msg}"`
fn is_api_5xx(msg: &str) -> bool {
    // Find "API error (" prefix, then check if the next digits start with "5".
    if let Some(rest) = msg.strip_prefix("API error (") {
        rest.starts_with('5')
    } else {
        false
    }
}

/// Parse the `retry-after` header value into a `Duration`.
///
/// Supports integer seconds ("60") only (the most common form from Anthropic).
pub fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retryable_rate_limit() {
        let e = TiguError::Provider("rate limited: Too many requests".into());
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_retryable_overloaded() {
        let e = TiguError::Provider("overloaded: Service overloaded".into());
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_retryable_408() {
        let e = TiguError::Provider("API error (408, request_timeout): timeout".into());
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_retryable_500() {
        let e = TiguError::Provider("API error (500, internal_server_error): oops".into());
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_retryable_529() {
        let e = TiguError::Provider("API error (529, overloaded): overloaded".into());
        // Doesn't start with "API error (5" ... actually it does!
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_not_retryable_400() {
        let e = TiguError::Provider("API error (400, invalid_request_error): bad request".into());
        assert!(!is_retryable(&e));
    }

    #[test]
    fn test_retryable_network() {
        let e = TiguError::Provider("request failed: connection refused".into());
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_retryable_timeout_error() {
        let e = TiguError::Timeout(30);
        assert!(is_retryable(&e));
    }

    #[test]
    fn test_not_retryable_config() {
        let e = TiguError::Config("missing key".into());
        assert!(!is_retryable(&e));
    }

    #[test]
    fn test_parse_retry_after() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_static("60"),
        );
        let d = parse_retry_after(&headers);
        assert_eq!(d, Some(Duration::from_secs(60)));
    }

    #[test]
    fn test_parse_retry_after_missing() {
        let headers = reqwest::header::HeaderMap::new();
        assert_eq!(parse_retry_after(&headers), None);
    }
}
