//! Environment configuration. Same variables as the TS server, plus the Rust-only
//! sizing knobs `HAPPY_WORKERS` and `DATABASE_POOL_SIZE`.

use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct S3Config {
    pub host: String,
    pub port: Option<u16>,
    pub use_ssl: bool,
    pub access_key: String,
    pub secret_key: String,
    pub bucket: String,
    pub region: String,
    pub public_url: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub master_secret: String,
    pub port: u16,
    /// `process.env.PORT` as given (used verbatim in local public file URLs).
    pub port_raw: Option<String>,
    /// Tokio worker threads.
    pub workers: usize,
    /// sqlx pool size.
    pub db_pool_size: u32,
    pub host: String,
    pub metrics_enabled: bool,
    pub metrics_port: u16,
    pub is_production: bool,
    pub data_dir: PathBuf,
    pub public_url: Option<String>,
    pub s3: Option<S3Config>,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    pub github_redirect_url: Option<String>,
    /// Webhooks are active only if all of the TS `initGithub` variables are set.
    pub github_webhook_secret: Option<String>,
    pub elevenlabs_api_key: Option<String>,
    pub dev_logging: bool,
    /// Overrides for tests: external endpoints.
    pub expo_push_url: String,
    pub elevenlabs_api: String,
    pub github_oauth_base: String,
    pub github_api_base: String,
    pub history: crate::history::HistoryConfig,
}

fn var(k: &str) -> Option<String> {
    env::var(k).ok().filter(|v| !v.is_empty())
}

fn parse_int_js(s: &str) -> Option<i64> {
    // parseInt(): leading whitespace, optional sign, leading digits.
    let t = s.trim_start();
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        let master_secret = var("HANDY_MASTER_SECRET").ok_or_else(|| anyhow::anyhow!("HANDY_MASTER_SECRET is required"))?;
        let database_url = var("DATABASE_URL").ok_or_else(|| anyhow::anyhow!("DATABASE_URL is required"))?;
        let data_dir = PathBuf::from(var("DATA_DIR").unwrap_or_else(|| "./data".into()));
        let s3 = var("S3_HOST").map(|host| S3Config {
            host,
            port: var("S3_PORT").and_then(|p| parse_int_js(&p)).map(|p| p as u16),
            use_ssl: var("S3_USE_SSL").map(|v| v == "true").unwrap_or(true),
            access_key: var("S3_ACCESS_KEY").unwrap_or_default(),
            secret_key: var("S3_SECRET_KEY").unwrap_or_default(),
            bucket: var("S3_BUCKET").unwrap_or_default(),
            region: var("S3_REGION").unwrap_or_else(|| "us-east-1".into()),
            public_url: env::var("S3_PUBLIC_URL").unwrap_or_else(|_| "undefined".into()),
        });
        let webhooks = ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_REDIRECT_URI", "GITHUB_WEBHOOK_SECRET"]
            .iter()
            .all(|k| var(k).is_some());
        let workers = var("HAPPY_WORKERS").and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0).unwrap_or_else(available_cpus);
        let db_pool_size = var("DATABASE_POOL_SIZE")
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|n| *n > 0)
            .or_else(|| crate::db::url_connection_limit(&database_url))
            .unwrap_or_else(|| (workers as u32 * 4).clamp(10, 200));
        Ok(Config {
            database_url,
            master_secret,
            port_raw: var("PORT"),
            workers,
            db_pool_size,
            port: var("PORT").and_then(|p| parse_int_js(&p)).map(|p| p as u16).unwrap_or(3005),
            host: var("HOST").unwrap_or_else(|| "0.0.0.0".into()),
            metrics_enabled: env::var("METRICS_ENABLED").map(|v| v != "false").unwrap_or(true),
            metrics_port: var("METRICS_PORT").and_then(|p| parse_int_js(&p)).map(|p| p as u16).unwrap_or(9090),
            is_production: env::var("NODE_ENV").map(|v| v == "production").unwrap_or(false),
            data_dir,
            public_url: var("PUBLIC_URL"),
            s3,
            github_client_id: var("GITHUB_CLIENT_ID"),
            github_client_secret: var("GITHUB_CLIENT_SECRET"),
            github_redirect_url: var("GITHUB_REDIRECT_URL"),
            github_webhook_secret: if webhooks { var("GITHUB_WEBHOOK_SECRET") } else { None },
            elevenlabs_api_key: var("ELEVENLABS_API_KEY"),
            dev_logging: var("DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING").is_some(),
            expo_push_url: var("HAPPY_RS_EXPO_PUSH_URL").unwrap_or_else(|| "https://exp.host/--/api/v2/push/send".into()),
            elevenlabs_api: var("HAPPY_RS_ELEVENLABS_API").unwrap_or_else(|| "https://api.elevenlabs.io/v1/convai".into()),
            github_oauth_base: var("HAPPY_RS_GITHUB_OAUTH_BASE").unwrap_or_else(|| "https://github.com".into()),
            github_api_base: var("HAPPY_RS_GITHUB_API_BASE").unwrap_or_else(|| "https://api.github.com".into()),
            history: crate::history::HistoryConfig::from_env()?,
        })
    }

    pub fn local_files_dir(&self) -> PathBuf {
        self.data_dir.join("files")
    }
}


/// CPUs this process may use: the affinity mask (`available_parallelism`) capped by
/// the cgroup v2 `cpu.max` quota, rounded up.
pub fn available_cpus() -> usize {
    let affinity = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    match cgroup_cpu_quota() {
        Some(q) => affinity.min(q.ceil().max(1.0) as usize),
        None => affinity,
    }
}

fn cgroup_cpu_quota() -> Option<f64> {
    // Our own cgroup from /proc/self/cgroup ("0::/path"), then walk up to the root:
    // the effective limit is the smallest quota on the path.
    let rel = std::fs::read_to_string("/proc/self/cgroup")
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("0::").map(|p| p.to_string()))?;
    let mut dir = PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/'));
    let mut best: Option<f64> = None;
    loop {
        if let Ok(s) = std::fs::read_to_string(dir.join("cpu.max")) {
            if let Some(q) = parse_cpu_max(&s) {
                best = Some(best.map_or(q, |b: f64| b.min(q)));
            }
        }
        if dir == std::path::Path::new("/sys/fs/cgroup") || !dir.pop() {
            break;
        }
    }
    best
}

/// `cpu.max` is "<quota> <period>" or "max <period>".
fn parse_cpu_max(s: &str) -> Option<f64> {
    let mut it = s.split_whitespace();
    let quota = it.next()?;
    let period: f64 = it.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None;
    }
    Some(quota.parse::<f64>().ok()? / period)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_max() {
        assert_eq!(parse_cpu_max("max 100000\n"), None);
        assert_eq!(parse_cpu_max("250000 100000\n"), Some(2.5));
        assert!(available_cpus() >= 1);
    }
}
