//! Outgoing HTTP with the behaviour of Node's global `fetch` (undici) where the
//! TS server's callers can observe it.

use crate::js;
use reqwest::header::HeaderValue;
use serde_json::Value;
use std::sync::LazyLock;

/// undici identifies itself as `node` (GitHub's API rejects requests without a
/// user agent).
pub static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().user_agent("node").build().expect("http client"));

/// `await response.json()`: UTF-8 whatever the charset, a leading BOM dropped,
/// then `JSON.parse`.
pub async fn json(resp: reqwest::Response) -> anyhow::Result<Value> {
    let bytes = resp.bytes().await?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    js::parse(text).map_err(|e| anyhow::anyhow!(e.message))
}

/// A `Headers` value: surrounding HTTP whitespace trimmed; NUL, CR, LF and
/// characters above U+00FF are a TypeError; the rest is sent as latin1.
pub fn header_value(s: &str) -> anyhow::Result<HeaderValue> {
    let t = s.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'));
    if t.chars().any(|c| matches!(c, '\0' | '\n' | '\r') || c as u32 > 0xff) {
        anyhow::bail!("Headers.append: \"{}\" is an invalid header value.", s);
    }
    let bytes: Vec<u8> = t.chars().map(|c| c as u8).collect();
    Ok(HeaderValue::from_bytes(&bytes)?)
}
