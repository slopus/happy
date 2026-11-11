//! Minimal S3 client with AWS SigV4, standing in for the `minio` npm client.
//!
//! The presigned GET URL and the presigned POST policy are reproduced exactly as
//! minio-js 8 builds them (same query order, escaping, policy JSON, form field
//! order and URL shape), because those strings are returned to clients verbatim.
//! Plain requests (put/head/list/delete) only need a valid signature.

use crate::config::S3Config;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

const ALGORITHM: &str = "AWS4-HMAC-SHA256";

pub struct S3 {
    /// Lowercased endpoint (`params.endPoint.toLowerCase()`).
    host: String,
    port: u16,
    use_ssl: bool,
    access_key: String,
    secret_key: String,
    region: String,
    http: reqwest::Client,
}

#[derive(Debug)]
pub struct ObjectStat {
    pub size: u64,
    pub etag: String,
}

#[derive(Debug)]
pub enum S3Error {
    NotFound,
    Other(String),
}

impl std::fmt::Display for S3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            S3Error::NotFound => f.write_str("Not Found"),
            S3Error::Other(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for S3Error {}

/// `encodeURIComponent` plus `!'()*`.
pub fn uri_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// `uriEscape` with `/` kept.
pub fn uri_resource_escape(s: &str) -> String {
    uri_escape(s).replace("%2F", "/")
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac key");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

fn date_long(ms: i64) -> String {
    let t = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default();
    t.format("%Y%m%dT%H%M%SZ").to_string()
}

fn date_short(ms: i64) -> String {
    let t = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default();
    t.format("%Y%m%d").to_string()
}

fn is_amazon_endpoint(host: &str) -> bool {
    host == "s3.amazonaws.com" || host == "s3.cn-north-1.amazonaws.com.cn"
}

fn s3_endpoint_for_region(region: &str) -> String {
    const KNOWN: &[&str] = &[
        "af-south-1", "ap-east-1", "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
        "ap-southeast-5", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ca-central-1", "ca-west-1", "eu-central-1",
        "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-2", "eu-west-3", "il-central-1",
        "me-central-1", "me-south-1", "sa-east-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2", "us-gov-east-1",
        "us-gov-west-1",
    ];
    if region == "cn-north-1" {
        "s3.cn-north-1.amazonaws.com.cn".into()
    } else if KNOWN.contains(&region) {
        format!("s3.{}.amazonaws.com", region)
    } else {
        "s3.amazonaws.com".into()
    }
}

/// minio `getRequestOptions` result.
struct ReqTarget {
    protocol: &'static str,
    /// Bare host (no port).
    host: String,
    /// Host header (with `:port` when not the scheme default).
    host_header: String,
    /// Path including `?query`.
    path: String,
}

impl S3 {
    pub fn new(c: &S3Config) -> S3 {
        let port = c.port.filter(|p| *p != 0).unwrap_or(if c.use_ssl { 443 } else { 80 });
        S3 {
            host: c.host.to_lowercase(),
            port,
            use_ssl: c.use_ssl,
            access_key: c.access_key.clone(),
            secret_key: c.secret_key.clone(),
            region: c.region.clone(),
            http: reqwest::Client::builder().build().expect("http client"),
        }
    }

    fn protocol(&self) -> &'static str {
        if self.use_ssl {
            "https:"
        } else {
            "http:"
        }
    }

    fn target(&self, bucket: &str, object: Option<&str>, query: Option<&str>) -> ReqTarget {
        let protocol = self.protocol();
        let virtual_host = !(protocol == "https:" && bucket.contains('.')) && is_amazon_endpoint(&self.host);
        let mut host = self.host.clone();
        if is_amazon_endpoint(&host) {
            host = s3_endpoint_for_region(&self.region);
        }
        let object = object.map(uri_resource_escape);
        let mut path;
        if virtual_host {
            host = format!("{}.{}", bucket, host);
            path = match &object {
                Some(o) => format!("/{}", o),
                None => "/".into(),
            };
        } else {
            path = format!("/{}", bucket);
            if let Some(o) = &object {
                path = format!("/{}/{}", bucket, o);
            }
        }
        if let Some(q) = query {
            path.push('?');
            path.push_str(q);
        }
        let default_port = if protocol == "http:" { 80 } else { 443 };
        let host_header = if self.port != default_port {
            if host.contains(':') {
                format!("[{}]:{}", host, self.port)
            } else {
                format!("{}:{}", host, self.port)
            }
        } else {
            host.clone()
        };
        ReqTarget { protocol, host, host_header, path }
    }

    fn signing_key(&self, ms: i64) -> Vec<u8> {
        let k1 = hmac(format!("AWS4{}", self.secret_key).as_bytes(), date_short(ms).as_bytes());
        let k2 = hmac(&k1, self.region.as_bytes());
        let k3 = hmac(&k2, b"s3");
        hmac(&k3, b"aws4_request")
    }

    fn scope(&self, ms: i64) -> String {
        format!("{}/{}/s3/aws4_request", date_short(ms), self.region)
    }

    /// minio `getCanonicalRequest`.
    fn canonical_request(method: &str, path: &str, headers: &[(String, String)], hashed_payload: &str) -> String {
        let (resource, query) = match path.split_once('?') {
            Some((r, q)) => (r, q),
            None => (path, ""),
        };
        let query = if query.is_empty() {
            String::new()
        } else {
            let mut parts: Vec<&str> = query.split('&').collect();
            parts.sort(); // JS default sort: UTF-16 code units; ASCII here
            parts.iter().map(|e| if e.contains('=') { e.to_string() } else { format!("{}=", e) }).collect::<Vec<_>>().join("&")
        };
        let header_lines: Vec<String> = headers.iter().map(|(k, v)| format!("{}:{}", k.to_lowercase(), collapse_spaces(v))).collect();
        let signed: Vec<String> = headers.iter().map(|(k, _)| k.to_lowercase()).collect();
        [method.to_uppercase(), resource.to_string(), query, header_lines.join("\n") + "\n", signed.join(";"), hashed_payload.to_string()].join("\n")
    }

    fn string_to_sign(&self, canonical: &str, ms: i64) -> String {
        let hash = hex::encode(Sha256::digest(canonical.as_bytes()));
        [ALGORITHM.to_string(), date_long(ms), self.scope(ms), hash].join("\n")
    }

    /// `presignedGetObject(bucket, key, expires)` at time `ms`.
    pub fn presigned_get_at(&self, bucket: &str, key: &str, expires: u32, ms: i64) -> String {
        let t = self.target(bucket, Some(key), None);
        let credential = format!("{}/{}", self.access_key, self.scope(ms));
        let query = [
            format!("X-Amz-Algorithm={}", ALGORITHM),
            format!("X-Amz-Credential={}", uri_escape(&credential)),
            format!("X-Amz-Date={}", date_long(ms)),
            format!("X-Amz-Expires={}", expires),
            format!("X-Amz-SignedHeaders={}", uri_escape("host")),
        ]
        .join("&");
        let path = format!("{}?{}", t.path, query);
        let canonical = Self::canonical_request("GET", &path, &[("host".into(), t.host_header.clone())], "UNSIGNED-PAYLOAD");
        let sig = hex::encode(hmac(&self.signing_key(ms), self.string_to_sign(&canonical, ms).as_bytes()));
        format!("{}//{}{}&X-Amz-Signature={}", t.protocol, t.host_header, path, sig)
    }

    pub fn presigned_get(&self, bucket: &str, key: &str, expires: u32) -> String {
        self.presigned_get_at(bucket, key, expires, crate::util::now_ms())
    }

    /// `newPostPolicy()` + setBucket + setKey + setExpires + setContentLengthRange,
    /// then `presignedPostPolicy`. Returns `{postURL, formData}`.
    pub fn presigned_post_at(&self, bucket: &str, key: &str, expires_at_ms: i64, min: u64, max: u64, ms: i64) -> (String, Map<String, Value>) {
        let date = date_long(ms);
        let credential = format!("{}/{}", self.access_key, self.scope(ms));
        let conditions = json!([
            ["eq", "$bucket", bucket],
            ["eq", "$key", key],
            ["content-length-range", min, max],
            ["eq", "$x-amz-date", date],
            ["eq", "$x-amz-algorithm", ALGORITHM],
            ["eq", "$x-amz-credential", credential],
        ]);
        let mut policy = Map::new();
        policy.insert("conditions".into(), conditions);
        policy.insert("expiration".into(), Value::String(crate::util::iso_from_ms(expires_at_ms)));
        let policy_b64 = crate::util::b64_encode(crate::js::stringify(&Value::Object(policy)).as_bytes());
        let signature = hex::encode(hmac(&self.signing_key(ms), policy_b64.as_bytes()));
        let mut form = Map::new();
        form.insert("bucket".into(), json!(bucket));
        form.insert("key".into(), json!(key));
        form.insert("x-amz-date".into(), json!(date));
        form.insert("x-amz-algorithm".into(), json!(ALGORITHM));
        form.insert("x-amz-credential".into(), json!(credential));
        form.insert("policy".into(), json!(policy_b64));
        form.insert("x-amz-signature".into(), json!(signature));
        let t = self.target(bucket, None, None);
        // minio: `this.port == 80 || this.port === 443 ? '' : ':' + port`, on the bare host.
        let port_str = if self.port == 80 || self.port == 443 { String::new() } else { format!(":{}", self.port) };
        (format!("{}//{}{}{}", t.protocol, t.host, port_str, t.path), form)
    }

    pub fn presigned_post(&self, bucket: &str, key: &str, expires_at_ms: i64, min: u64, max: u64) -> (String, Map<String, Value>) {
        self.presigned_post_at(bucket, key, expires_at_ms, min, max, crate::util::now_ms())
    }

    // -----------------------------------------------------------------------
    // Signed requests
    // -----------------------------------------------------------------------

    async fn request(
        &self,
        method: &str,
        bucket: &str,
        object: Option<&str>,
        query: Option<&str>,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, S3Error> {
        let t = self.target(bucket, object, query);
        let ms = crate::util::now_ms();
        let sha = hex::encode(Sha256::digest(&body));
        let headers = vec![
            ("host".to_string(), t.host_header.clone()),
            ("x-amz-content-sha256".to_string(), sha.clone()),
            ("x-amz-date".to_string(), date_long(ms)),
        ];
        let canonical = Self::canonical_request(method, &t.path, &headers, &sha);
        let sig = hex::encode(hmac(&self.signing_key(ms), self.string_to_sign(&canonical, ms).as_bytes()));
        let auth = format!(
            "{} Credential={}/{}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={}",
            ALGORITHM,
            self.access_key,
            self.scope(ms),
            sig
        );
        let url = format!("{}//{}{}", t.protocol, t.host_header, t.path);
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| S3Error::Other(e.to_string()))?;
        let mut rb = self
            .http
            .request(m, url)
            .header("authorization", auth)
            .header("x-amz-content-sha256", sha)
            .header("x-amz-date", date_long(ms));
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if !body.is_empty() || method == "PUT" {
            rb = rb.body(body);
        }
        rb.send().await.map_err(|e| S3Error::Other(e.to_string()))
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response, S3Error> {
        let status = resp.status().as_u16();
        if status < 300 {
            return Ok(resp);
        }
        let text = resp.text().await.unwrap_or_default();
        if status == 404 {
            return Err(S3Error::NotFound);
        }
        let code = xml_tag(&text, "Code").unwrap_or_default();
        let msg = xml_tag(&text, "Message").unwrap_or_default();
        Err(S3Error::Other(format!("S3 {}: {} {}", status, code, msg)))
    }

    pub async fn bucket_exists(&self, bucket: &str) -> Result<bool, S3Error> {
        match Self::check(self.request("HEAD", bucket, None, None, vec![], None).await?).await {
            Ok(_) => Ok(true),
            Err(S3Error::NotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// minio `putObject(bucket, key, buffer)` sends no Content-Type.
    pub async fn put_object(&self, bucket: &str, key: &str, data: Vec<u8>) -> Result<(), S3Error> {
        Self::check(self.request("PUT", bucket, Some(key), None, data, None).await?).await?;
        Ok(())
    }

    pub async fn stat_object(&self, bucket: &str, key: &str) -> Result<ObjectStat, S3Error> {
        let r = Self::check(self.request("HEAD", bucket, Some(key), None, vec![], None).await?).await?;
        let size = r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
        let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").trim_matches('"').to_string();
        Ok(ObjectStat { size, etag })
    }

    pub async fn get_object(&self, bucket: &str, key: &str) -> Result<Vec<u8>, S3Error> {
        let r = Self::check(self.request("GET", bucket, Some(key), None, vec![], None).await?).await?;
        r.bytes().await.map(|b| b.to_vec()).map_err(|e| S3Error::Other(e.to_string()))
    }

    pub async fn remove_object(&self, bucket: &str, key: &str) -> Result<(), S3Error> {
        match Self::check(self.request("DELETE", bucket, Some(key), None, vec![], None).await?).await {
            Ok(_) | Err(S3Error::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// `removeObjects`: deletes each key (bounded concurrency).
    pub async fn remove_objects(&self, bucket: &str, keys: &[String]) -> Result<(), S3Error> {
        use futures_util::stream::{self, TryStreamExt};
        stream::iter(keys.iter().map(Ok::<_, S3Error>))
            .try_for_each_concurrent(8, |k| async move { self.remove_object(bucket, k).await })
            .await
    }

    /// `listObjects(bucket, prefix, true)`: all keys under the prefix.
    pub async fn list_objects(&self, bucket: &str, prefix: &str) -> Result<Vec<String>, S3Error> {
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut q = vec![("list-type".to_string(), "2".to_string()), ("prefix".to_string(), prefix.to_string())];
            if let Some(t) = &token {
                q.push(("continuation-token".to_string(), t.clone()));
            }
            let query = q.iter().map(|(k, v)| format!("{}={}", uri_escape(k), uri_escape(v))).collect::<Vec<_>>().join("&");
            let r = Self::check(self.request("GET", bucket, None, Some(&query), vec![], None).await?).await?;
            let text = r.text().await.map_err(|e| S3Error::Other(e.to_string()))?;
            for c in text.split("<Contents>").skip(1) {
                if let Some(k) = xml_tag(c, "Key") {
                    keys.push(k);
                }
            }
            if xml_tag(&text, "IsTruncated").as_deref() == Some("true") {
                token = xml_tag(&text, "NextContinuationToken");
                if token.is_none() {
                    break;
                }
            } else {
                break;
            }
        }
        Ok(keys)
    }
}

fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c == ' ' {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

fn xml_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let a = s.find(&open)? + open.len();
    let b = s[a..].find(&close)? + a;
    Some(xml_unescape(&s[a..b]))
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(port: Option<u16>, ssl: bool) -> S3 {
        S3::new(&S3Config {
            host: "Minio.Example.com".into(),
            port,
            use_ssl: ssl,
            access_key: "AKIAEXAMPLE".into(),
            secret_key: "secret/Key+1".into(),
            bucket: "happy".into(),
            region: "us-east-1".into(),
            public_url: "undefined".into(),
        })
    }

    // Vectors produced by minio-js 8 (`.context/probe/minio_vectors.mjs`).
    #[test]
    fn presign_matches_minio_js() {
        let ms = 1_762_000_000_123;
        let c = client(Some(9000), false);
        assert_eq!(
            c.presigned_get_at("happy", "sessions/s1/attachments/a b+(c)!.bin", 900, ms),
            include_str!("../../testdata/minio_get_9000.txt").trim()
        );
        let c = client(None, true);
        assert_eq!(c.presigned_get_at("happy", "x/y.png", 900, ms), include_str!("../../testdata/minio_get_443.txt").trim());
        let c = client(Some(9000), false);
        let (url, form) = c.presigned_post_at("happy", "sessions/s1/attachments/f.bin", ms + 900_000, 0, 10_485_760, ms);
        let got = crate::js::stringify(&json!({"postURL": url, "formData": form}));
        assert_eq!(got, include_str!("../../testdata/minio_post_9000.txt").trim());
    }
}
