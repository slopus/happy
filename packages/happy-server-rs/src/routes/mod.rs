//! HTTP routes, one module per TS route file.

pub mod access_keys;
pub mod account;
pub mod artifacts;
pub mod kv;
pub mod auth;
pub mod machines;
pub mod misc;
pub mod projects;
pub mod push;
pub mod session_files;
pub mod sessions;
pub mod social;
pub mod uploads;
pub mod v3;
pub mod version;

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
    kv::register(r);
    social::register(r);
    projects::register(r);
    push::register(r);
    session_files::register(r);
    version::register(r, c);
}

/// Prisma's `new Date(x)` accepts only JS-representable instants (±8.64e15 ms);
/// anything else is an "Invalid Date" that makes the query throw.
pub fn js_date_ms(ms: f64) -> anyhow::Result<chrono::NaiveDateTime> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        anyhow::bail!("Invalid Date");
    }
    Ok(crate::util::ms_to_naive(ms.trunc() as i64))
}
