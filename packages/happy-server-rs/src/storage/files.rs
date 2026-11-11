//! `storage/files.ts`: local directory (`DATA_DIR/files`) or S3 when `S3_HOST` is set.

use super::s3::{S3Error, S3};
use crate::config::Config;
use std::path::{Component, Path, PathBuf};

pub struct Files {
    pub s3: Option<S3>,
    pub bucket: String,
    /// `S3_HOST` as given (used by `resolveImageUrl`).
    pub s3_host: String,
    s3_public: String,
    local_dir: PathBuf,
    local_base_url: String,
}

impl Files {
    pub fn new(c: &Config) -> Files {
        let local_base_url = c
            .public_url
            .clone()
            .unwrap_or_else(|| format!("http://localhost:{}", c.port_raw.clone().unwrap_or_else(|| "3005".into())));
        Files {
            s3: c.s3.as_ref().map(S3::new),
            bucket: c.s3.as_ref().map(|s| s.bucket.clone()).unwrap_or_default(),
            s3_host: c.s3.as_ref().map(|s| s.host.clone()).unwrap_or_default(),
            s3_public: c.s3.as_ref().map(|s| s.public_url.clone()).unwrap_or_default(),
            local_dir: c.local_files_dir(),
            local_base_url,
        }
    }

    pub fn is_local(&self) -> bool {
        self.s3.is_none()
    }

    pub fn local_dir(&self) -> &Path {
        &self.local_dir
    }

    /// `loadFiles`: create the local dir, or probe the bucket.
    pub async fn load(&self) -> anyhow::Result<()> {
        match &self.s3 {
            None => {
                tokio::fs::create_dir_all(&self.local_dir).await?;
            }
            Some(s3) => {
                s3.bucket_exists(&self.bucket).await?;
            }
        }
        Ok(())
    }

    pub fn public_url(&self, path: &str) -> String {
        if self.is_local() {
            format!("{}/files/{}", self.local_base_url, path)
        } else {
            format!("{}/{}", self.s3_public, path)
        }
    }

    /// `resolveImageUrl`.
    pub fn resolve_image_url(&self, path: &str) -> String {
        if self.is_local() {
            self.public_url(path)
        } else {
            format!("https://{}/{}/{}", self.s3_host, self.bucket, path)
        }
    }

    /// `path.join(localFilesDir, filePath)` (normalizes `..`).
    pub fn local_path(&self, rel: &str) -> PathBuf {
        normalize_join(&self.local_dir, rel)
    }

    pub async fn put_local(&self, rel: &str, data: &[u8]) -> std::io::Result<()> {
        let full = self.local_path(rel);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(full, data).await
    }

    /// Writes a public image (`uploadImage`): local file or S3 object.
    pub async fn put(&self, rel: &str, data: Vec<u8>) -> anyhow::Result<()> {
        match &self.s3 {
            None => self.put_local(rel, &data).await?,
            Some(s3) => s3.put_object(&self.bucket, rel, data).await?,
        }
        Ok(())
    }

    async fn delete_prefix(&self, prefix_dir: &str, s3_prefix: &str) -> anyhow::Result<()> {
        match &self.s3 {
            None => {
                let dir = self.local_path(prefix_dir);
                match tokio::fs::remove_dir_all(&dir).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Some(s3) => {
                let keys: Vec<String> = s3.list_objects(&self.bucket, s3_prefix).await?.into_iter().filter(|k| k.starts_with(s3_prefix)).collect();
                for chunk in keys.chunks(100) {
                    s3.remove_objects(&self.bucket, chunk).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn delete_session_attachments(&self, session_id: &str) -> anyhow::Result<()> {
        let prefix = format!("sessions/{}/attachments", session_id);
        self.delete_prefix(&prefix, &format!("{}/", prefix)).await
    }

    pub async fn delete_session_avatars(&self, session_id: &str) -> anyhow::Result<()> {
        if session_id.is_empty() || !session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            anyhow::bail!("Invalid session identifier");
        }
        let prefix = format!("sessions/{}/avatar/", session_id);
        self.delete_prefix(&prefix, &prefix).await
    }

    pub async fn delete_project_avatars(&self, project_id: &str) -> anyhow::Result<()> {
        let prefix = format!("projects/{}/avatar", project_id);
        self.delete_prefix(&prefix, &format!("{}/", prefix)).await
    }

    pub async fn stat(&self, key: &str) -> Result<super::s3::ObjectStat, S3Error> {
        match &self.s3 {
            Some(s3) => s3.stat_object(&self.bucket, key).await,
            None => Err(S3Error::Other("local storage".into())),
        }
    }
}

/// Node's `path.join` + `path.resolve` semantics for a relative path under `base`.
pub fn normalize_join(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::ParentDir => {
                out.pop();
            }
            // `path.join` keeps a leading slash relative.
            _ => {}
        }
    }
    out
}

/// `publicLocalFilePath`: `None` when the path escapes the root or targets session
/// avatar ciphertext.
pub fn public_local_file_path(base: &Path, requested: &str) -> Option<PathBuf> {
    let root = absolutize(base);
    let full = if requested.starts_with('/') { lexical_normalize(Path::new(requested)) } else { lexical_normalize(&root.join(requested)) };
    let rel = full.strip_prefix(&root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.first().map(|s| s.as_str()) == Some("sessions") && parts.get(2).map(|s| s.as_str()) == Some("avatar") {
        return None;
    }
    Some(full)
}

fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        lexical_normalize(p)
    } else {
        lexical_normalize(&std::env::current_dir().unwrap_or_default().join(p))
    }
}

fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            Component::Normal(x) => out.push(x),
            Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_paths() {
        let base = Path::new("/data/files");
        assert_eq!(public_local_file_path(base, "public/a.png"), Some(PathBuf::from("/data/files/public/a.png")));
        assert_eq!(public_local_file_path(base, "../x"), None);
        assert_eq!(public_local_file_path(base, ""), None);
        assert_eq!(public_local_file_path(base, "sessions/s/avatar/x"), None);
        assert_eq!(public_local_file_path(base, "sessions/s/attachments/x"), Some(PathBuf::from("/data/files/sessions/s/attachments/x")));
        assert_eq!(public_local_file_path(base, "a/../../files/b"), Some(PathBuf::from("/data/files/b")));
    }
}
