//! HTTP routes, one module per TS route file.

pub mod access_keys;
pub mod account;
pub mod artifacts;
pub mod auth;
pub mod machines;
pub mod misc;
pub mod sessions;
pub mod v3;

use crate::config::Config;
use crate::http::Router;

pub fn register(r: &mut Router, c: &Config) {
    misc::register(r, c);
    auth::register(r);
    sessions::register(r);
    account::register(r);
    v3::register(r);
    machines::register(r);
    artifacts::register(r);
    access_keys::register(r);
}

/// Prisma's `new Date(x)` accepts only JS-representable instants (±8.64e15 ms);
/// anything else is an "Invalid Date" that makes the query throw.
pub fn js_date_ms(ms: f64) -> anyhow::Result<chrono::NaiveDateTime> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        anyhow::bail!("Invalid Date");
    }
    Ok(crate::util::ms_to_naive(ms.trunc() as i64))
}
