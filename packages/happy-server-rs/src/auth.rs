//! Port of the parts of `privacy-kit` the server uses: persistent and ephemeral
//! EdDSA JWTs (key = PBKDF2-SHA512 of HANDY_MASTER_SECRET) and the KeyTree
//! AES-256-GCM encryption for stored vendor/GitHub tokens. Tokens issued by the TS
//! server verify here and vice versa.

use crate::js;
use crate::util::now_ms;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use dashmap::DashMap;
use rand::RngCore;
use serde_json::{Map, Value};
use sha2::Sha512;

const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// privacy-kit `deriveSecureKey`: PBKDF2-SHA512, 210000 rounds, 64 bytes.
pub fn derive_secure_key(key: &str, usage: &str) -> [u8; 64] {
    let mut out = [0u8; 64];
    pbkdf2::pbkdf2::<Hmac<Sha512>>(key.as_bytes(), usage.as_bytes(), 210_000, &mut out).unwrap();
    out
}

fn hmac_sha512(key: &[u8], data: &[u8]) -> [u8; 64] {
    let mut m = <Hmac<Sha512> as Mac>::new_from_slice(key).unwrap();
    m.update(data);
    m.finalize().into_bytes().into()
}

pub struct TokenKeys {
    signing: SigningKey,
    verifying: VerifyingKey,
    service: &'static str,
}

impl TokenKeys {
    fn new(secret: &str, service: &'static str, kind: &str) -> Self {
        let k = derive_secure_key(secret, &format!("{} {}", service, kind));
        let signing = SigningKey::from_bytes(&k[..32].try_into().unwrap());
        let verifying = signing.verifying_key();
        TokenKeys { signing, verifying, service }
    }

    fn sign(&self, sub: &str, extras: Option<&Map<String, Value>>, ttl_ms: Option<i64>) -> String {
        let now = now_ms();
        let now_s = now / 1000;
        let mut p = Map::new();
        p.insert("sub".into(), Value::String(sub.to_string()));
        if let Some(e) = extras {
            for (k, v) in e {
                p.insert(k.clone(), v.clone());
            }
        }
        p.insert("iat".into(), js::num(now_s as f64));
        p.insert("nbf".into(), js::num(now_s as f64));
        if let Some(ttl) = ttl_ms {
            p.insert("exp".into(), js::num(((now + ttl) / 1000) as f64));
        }
        p.insert("iss".into(), Value::String(self.service.to_string()));
        p.insert("jti".into(), Value::String(crate::util::uuid_v4()));
        let header = B64URL.encode(br#"{"alg":"EdDSA"}"#);
        let payload = B64URL.encode(js::stringify(&Value::Object(p)).as_bytes());
        let input = format!("{}.{}", header, payload);
        let sig = self.signing.sign(input.as_bytes());
        format!("{}.{}", input, B64URL.encode(sig.to_bytes()))
    }

    /// jose `jwtVerify` + privacy-kit's issuer check. Returns (sub, extras).
    fn verify(&self, token: &str) -> Option<(Value, Map<String, Value>)> {
        let mut parts = token.split('.');
        let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let header = js::parse(std::str::from_utf8(&B64URL.decode(h).ok()?).ok()?).ok()?;
        let header = header.as_object()?;
        match header.get("alg").and_then(|a| a.as_str()) {
            Some("EdDSA") | Some("Ed25519") => {}
            _ => return None,
        }
        if header.contains_key("crit") || header.get("b64") == Some(&Value::Bool(false)) {
            return None;
        }
        let sig = Signature::from_slice(&B64URL.decode(s).ok()?).ok()?;
        self.verifying.verify(format!("{}.{}", h, p).as_bytes(), &sig).ok()?;
        let payload = js::parse(std::str::from_utf8(&B64URL.decode(p).ok()?).ok()?).ok()?;
        let payload = payload.as_object()?.clone();
        let now = (now_ms() / 1000) as f64;
        for k in ["iat", "nbf", "exp"] {
            if let Some(v) = payload.get(k) {
                if !v.is_number() {
                    return None;
                }
            }
        }
        if let Some(nbf) = payload.get("nbf").and_then(|v| v.as_f64()) {
            if nbf > now {
                return None;
            }
        }
        if let Some(exp) = payload.get("exp").and_then(|v| v.as_f64()) {
            if exp <= now {
                return None;
            }
        }
        if payload.get("iss").and_then(|v| v.as_str()) != Some(self.service) {
            return None;
        }
        let sub = payload.get("sub").cloned().unwrap_or(Value::Null);
        let mut extras = payload;
        for k in ["iss", "sub", "aud", "jti", "nbf", "exp", "iat"] {
            extras.shift_remove(k);
        }
        Some((sub, extras))
    }
}

struct CacheEntry {
    user_id: String,
    cached_at: i64,
}

const TOKEN_CACHE_TTL: i64 = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE: usize = 10_000;

pub struct Auth {
    persistent: TokenKeys,
    github: TokenKeys,
    /// Verified-token cache; sharded so concurrent requests never serialize on it.
    cache: DashMap<String, CacheEntry>,
    key_tree: KeyTree,
}

impl Auth {
    pub fn new(secret: &str) -> Self {
        Auth {
            persistent: TokenKeys::new(secret, "handy", "Persistent Token"),
            github: TokenKeys::new(secret, "github-happy", "Ephemeral Token"),
            cache: DashMap::new(),
            key_tree: KeyTree::new(derive_secure_key(secret, "happy-server-tokens")),
        }
    }

    pub fn create_token(&self, user_id: &str, extras: Option<&Map<String, Value>>) -> String {
        let t = self.persistent.sign(user_id, extras, None);
        self.cache.insert(t.clone(), CacheEntry { user_id: user_id.to_string(), cached_at: now_ms() });
        t
    }

    pub fn verify_token(&self, token: &str) -> Option<String> {
        if let Some(e) = self.cache.get(token) {
            if now_ms() - e.cached_at <= TOKEN_CACHE_TTL {
                return Some(e.user_id.clone());
            }
            drop(e);
            self.cache.remove_if(token, |_, e| now_ms() - e.cached_at > TOKEN_CACHE_TTL);
        }
        let (sub, _extras) = self.persistent.verify(token)?;
        // `verified.user as string`: a missing sub is `null`, stringified by the route.
        let user_id = match sub {
            Value::String(s) => s,
            other => js::to_js_string(&other),
        };
        if self.cache.len() >= MAX_CACHE_SIZE {
            let mut entries: Vec<(String, i64)> = self.cache.iter().map(|e| (e.key().clone(), e.cached_at)).collect();
            entries.sort_by_key(|e| e.1);
            for (k, _) in entries.into_iter().take(MAX_CACHE_SIZE / 5) {
                self.cache.remove(&k);
            }
        }
        self.cache.insert(token.to_string(), CacheEntry { user_id: user_id.clone(), cached_at: now_ms() });
        Some(user_id)
    }

    pub fn cleanup(&self) {
        let now = now_ms();
        self.cache.retain(|_, e| now - e.cached_at <= TOKEN_CACHE_TTL);
    }

    pub fn create_github_token(&self, user_id: &str) -> String {
        self.github.sign(user_id, None, Some(5 * 60 * 1000))
    }

    pub fn verify_github_token(&self, token: &str) -> Option<String> {
        let (sub, _) = self.github.verify(token)?;
        Some(match sub {
            Value::String(s) => s,
            other => js::to_js_string(&other),
        })
    }

    pub fn encrypt_string(&self, path: &[&str], s: &str) -> Vec<u8> {
        self.key_tree.symmetric_encrypt(path, s.as_bytes())
    }

    pub fn decrypt_string(&self, path: &[&str], data: &[u8]) -> anyhow::Result<String> {
        let b = self.key_tree.symmetric_decrypt(path, data)?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }
}

/// privacy-kit `KeyTree`.
pub struct KeyTree {
    master: [u8; 64],
}

impl KeyTree {
    pub fn new(master: [u8; 64]) -> Self {
        KeyTree { master }
    }

    fn derive_key(&self, algo: &str, path: &[&str]) -> [u8; 32] {
        let mut remaining: Vec<String> = path.iter().map(|s| s.to_string()).collect();
        remaining.push(format!("#{}", algo));
        let mut state: Vec<u8> = self.master.to_vec();
        for (i, index) in remaining.iter().enumerate() {
            let mut data = vec![0u8];
            data.extend_from_slice(index.as_bytes());
            let ch = hmac_sha512(&state, &data);
            if i + 1 < remaining.len() {
                state = ch[32..].to_vec();
            } else {
                return ch[..32].try_into().unwrap();
            }
        }
        unreachable!()
    }

    pub fn symmetric_encrypt(&self, path: &[&str], data: &[u8]) -> Vec<u8> {
        let key = self.derive_key("aes256", path);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: data, aad: &[] }).unwrap();
        let mut out = vec![0u8];
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct); // ciphertext || tag, same as privacy-kit
        out
    }

    pub fn symmetric_decrypt(&self, path: &[&str], data: &[u8]) -> anyhow::Result<Vec<u8>> {
        if data.first() != Some(&0) || data.len() < 13 + 16 {
            anyhow::bail!("Invalid data");
        }
        let key = self.derive_key("aes256", path);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        cipher
            .decrypt(Nonce::from_slice(&data[1..13]), Payload { msg: &data[13..], aad: &[] })
            .map_err(|_| anyhow::anyhow!("Unsupported state or unable to authenticate data"))
    }
}

/// tweetnacl `sign.detached.verify`; `Err` mirrors its size exceptions.
pub fn nacl_verify(msg: &[u8], sig: &[u8], pk: &[u8]) -> Result<bool, String> {
    if sig.len() != 64 {
        return Err("bad signature size".into());
    }
    if pk.len() != 32 {
        return Err("bad public key size".into());
    }
    let Ok(vk) = VerifyingKey::from_bytes(pk.try_into().unwrap()) else {
        return Ok(false);
    };
    let sig = Signature::from_slice(sig).map_err(|e| e.to_string())?;
    Ok(vk.verify(msg, &sig).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let a = Auth::new("test-master-secret");
        let t = a.create_token("u1", None);
        a.cache.clear();
        assert_eq!(a.verify_token(&t).as_deref(), Some("u1"));
        assert!(a.verify_token(&format!("{}x", t)).is_none());
        let g = a.create_github_token("u2");
        assert_eq!(a.verify_github_token(&g).as_deref(), Some("u2"));
        assert!(a.verify_token(&g).is_none());
        let enc = a.encrypt_string(&["user", "u", "vendors", "openai", "token"], "sk-1");
        assert_eq!(a.decrypt_string(&["user", "u", "vendors", "openai", "token"], &enc).unwrap(), "sk-1");
    }

    /// `KeyTree.symmetricEncrypt` output from privacy-kit (master secret test-master-secret).
    #[test]
    fn decrypts_privacy_kit_key_tree() {
        let a = Auth::new("test-master-secret");
        let enc = hex::decode("002d2d2bd19754b0938a8e0f15640e11e0d1d4a28cfe8ff06d845cf58395cdaefede29f356").unwrap();
        let path = ["user", "u", "vendors", "openai", "token"];
        assert_eq!(a.decrypt_string(&path, &enc).unwrap(), "sk-ts-é");
        assert!(a.decrypt_string(&["user", "v", "vendors", "openai", "token"], &enc).is_err());
    }

    /// Token minted by the TS server (privacy-kit) with HANDY_MASTER_SECRET=test-master-secret.
    #[test]
    fn verifies_ts_token() {
        let a = Auth::new("test-master-secret");
        let t = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJjbXdjZjYxeXEwMDAwY3hjbm83OWw4a2N6IiwiaWF0IjoxNzk0NDE5NzE1LCJuYmYiOjE3OTQ0MTk3MTUsImlzcyI6ImhhbmR5IiwianRpIjoiNjZjOGFlMzMtOTFkZi00YTRiLThjYjYtZDJkZDU4NzMyNTUzIn0.wk7Sy38RLtC-ibS2ulhpfLjD6Rg9UWLFug5rhWrXJPEk5NYv2i7HnVt4biC4NkH2XmubUyNGclhJODAPQpYVAA";
        assert_eq!(a.verify_token(t).as_deref(), Some("cmwcf61yq0000cxcno79l8kcz"));
    }
}
