//! `versionRoutes.ts` and `devRoutes.ts`.

use crate::app::App;
use crate::config::Config;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::zod::{any, enumeration, object, string};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex};

/// `IOS_UP_TO_DATE` and `ANDROID_UP_TO_DATE`: `>=1.4.1`.
const UP_TO_DATE: (f64, f64, f64) = (1.0, 4.0, 1.0);

pub fn register(r: &mut Router, c: &Config) {
    r.post("/v1/version")
        .body(object(vec![("platform", string()), ("version", string()), ("app_id", string())]))
        .response(200, object(vec![("updateUrl", string().nullable())]))
        .handle(h!(version));

    if c.dev_logging {
        r.post("/logs-combined-from-cli-and-mobile-for-simple-ai-debugging")
            .body(object(vec![
                ("timestamp", string()),
                ("level", string()),
                ("message", string()),
                ("messageRawObject", any().optional()),
                ("source", enumeration(&["mobile", "cli"])),
                ("platform", string().optional()),
            ]))
            .handle(h!(dev_log));
    }
}

async fn version(_: Arc<App>, req: Req) -> HResult {
    let platform = req.body_str("platform").unwrap_or_default().to_lowercase();
    let v = req.body_str("version").unwrap_or_default();
    let url = match platform.as_str() {
        "ios" if !satisfies(&v) => json!("https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"),
        "android" if !satisfies(&v) => json!("https://play.google.com/store/apps/details?id=com.ex3ndr.happy"),
        _ => Value::Null,
    };
    Reply::json(json!({ "updateUrl": url }))
}

/// node-semver 7 `satisfies(version, '>=1.4.1')`: a strict `SemVer` (optional
/// leading `v`, no leading zeros, at most 256 characters, components up to
/// `MAX_SAFE_INTEGER`); prereleases never satisfy a range without one.
fn satisfies(version: &str) -> bool {
    static FULL: LazyLock<regex::Regex> = LazyLock::new(|| {
        let num = r"0|[1-9][0-9]{0,256}";
        let pre_id = format!(r"(?:[0-9]{{0,256}}[a-zA-Z-][a-zA-Z0-9-]{{0,250}}|{})", num);
        let build_id = r"[a-zA-Z0-9-]{1,250}";
        regex::Regex::new(&format!(
            r"^v?({num})\.({num})\.({num})(?:-({pre}(?:\.{pre})*))?(?:\+({b}(?:\.{b})*))?$",
            num = num,
            pre = pre_id,
            b = build_id
        ))
        .unwrap()
    });
    if version.is_empty() || version.encode_utf16().count() > 256 {
        return false;
    }
    let Some(m) = FULL.captures(version.trim_matches(crate::js::is_js_whitespace)) else { return false };
    let part = |i: usize| m.get(i).map(|g| g.as_str().parse::<f64>().unwrap_or(f64::INFINITY)).unwrap_or(0.0);
    let (major, minor, patch) = (part(1), part(2), part(3));
    if [major, minor, patch].iter().any(|n| *n > 9007199254740991.0) || m.get(4).is_some() {
        return false;
    }
    (major, minor, patch) >= UP_TO_DATE
}

/// The `.logs/MM-DD-HH-MM-SS.log` file opened once at startup (pino JSON lines).
static DEV_LOG: LazyLock<Option<Mutex<std::fs::File>>> = LazyLock::new(|| {
    let dir = std::env::current_dir().ok()?.join(".logs");
    std::fs::create_dir_all(&dir).ok()?;
    let name = chrono::Local::now().format("%m-%d-%H-%M-%S.log").to_string();
    std::fs::OpenOptions::new().create(true).append(true).open(dir.join(name)).ok().map(Mutex::new)
});

async fn dev_log(_: Arc<App>, req: Req) -> HResult {
    let level = match req.body_str("level").unwrap_or_default().to_lowercase().as_str() {
        "error" => 50,
        "warn" | "warning" => 40,
        "debug" => 20,
        _ => 30,
    };
    if let Some(file) = DEV_LOG.as_ref() {
        let local = chrono::Local::now().format("%H:%M:%S").to_string();
        let mut line = Map::new();
        line.insert("level".into(), json!(level));
        line.insert("time".into(), json!(crate::util::now_ms()));
        line.insert("localTime".into(), json!(local));
        line.insert("pid".into(), json!(std::process::id()));
        line.insert("hostname".into(), json!(crate::util::hostname()));
        for k in ["source", "platform", "timestamp"] {
            if let Some(v) = req.body_field(k) {
                line.insert(k.into(), v.clone());
            }
        }
        line.insert("msg".into(), json!(req.body_str("message").unwrap_or_default()));
        if let Ok(mut f) = file.lock() {
            let _ = writeln!(f, "{}", crate::js::stringify(&Value::Object(line)));
        }
    }
    Reply::json(json!({"success": true}))
}
