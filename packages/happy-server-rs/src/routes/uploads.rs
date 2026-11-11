//! Helpers shared by the encrypted-blob routes (project avatars, session avatars,
//! attachments): the base URL of local upload links and the request body as a Buffer.

use crate::app::App;
use crate::http::Req;

/// `resolveBaseUrl` / `baseUrl`: `PUBLIC_URL`, else `x-forwarded-proto://x-forwarded-host`
/// falling back to `http` and the `Host` header, else `http://localhost:PORT`.
/// Node joins repeated `x-forwarded-*` headers with ", ".
pub fn base_url(app: &App, req: &Req) -> String {
    if let Some(u) = app.config.public_url.as_deref().filter(|u| !u.is_empty()) {
        return u.to_string();
    }
    let joined = |name: &str| -> Option<String> {
        let vals: Vec<String> = req.headers.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
        if vals.is_empty() {
            None
        } else {
            Some(vals.join(", "))
        }
    };
    let host = joined("x-forwarded-host").or_else(|| req.header("host").map(String::from));
    let proto = joined("x-forwarded-proto").unwrap_or_else(|| "http".into());
    match host {
        Some(h) if !h.is_empty() => format!("{}://{}", proto, h),
        _ => format!("http://localhost:{}", app.config.port_raw.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "3005".into())),
    }
}

/// `request.body` when it is a Buffer: only the `application/octet-stream` parser
/// produces one.
pub fn buffer_body(req: &Req) -> Option<&[u8]> {
    let ct = req.header("content-type")?;
    let media = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    (media == "application/octet-stream" && req.body.is_some()).then_some(&req.raw_body[..])
}

/// Upload links expire after 15 minutes.
pub const PRESIGNED_TTL_SECONDS: u32 = 15 * 60;
pub const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;
