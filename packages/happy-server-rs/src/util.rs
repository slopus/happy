//! Small ports of the JS helpers the TS server depends on.

use chrono::{DateTime, NaiveDateTime, Utc};
use rand::{Rng, RngCore};
use std::sync::atomic::{AtomicU32, Ordering};

// ---------------------------------------------------------------------------
// Time: Prisma stores TIMESTAMP(3) without time zone, interpreted as UTC.
// ---------------------------------------------------------------------------

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn ms_to_naive(ms: i64) -> NaiveDateTime {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().naive_utc()
}

pub fn naive_to_ms(t: NaiveDateTime) -> i64 {
    t.and_utc().timestamp_millis()
}

/// `new Date().toISOString()`
pub fn iso_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

pub fn b64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// `@stablelib/base64` `decode` (used by `privacyKit.decodeBase64`), including its
/// quirks: unpadded input decodes leniently, inputs shorter than 4 characters throw.
pub fn stablelib_b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.is_empty() {
        return Ok(vec![]);
    }
    let mut padding = 0usize;
    for &u in units.iter().rev() {
        if u != b'=' as u16 {
            break;
        }
        padding += 1;
    }
    if units.len() < 4 || padding > 2 {
        return Err("Base64Coder: incorrect padding".into());
    }
    const INVALID: i32 = 256;
    fn dec(c: u16) -> i32 {
        let c = c as i32;
        match c {
            43 => 62,                 // +
            47 => 63,                 // /
            48..=57 => c - 48 + 52,   // 0-9
            65..=90 => c - 65,        // A-Z
            97..=122 => c - 97 + 26,  // a-z
            _ => INVALID,
        }
    }
    let length = units.len() - padding;
    let max = length * 3 / 4; // JS: length / 4 * 3 | 0 (float division)
    let mut out = vec![0u8; max];
    let mut op = 0usize;
    let mut bad = 0i32;
    let put = |out: &mut Vec<u8>, op: &mut usize, b: i32| {
        if *op < out.len() {
            out[*op] = (b & 0xff) as u8;
        }
        *op += 1;
    };
    let mut i = 0usize;
    let (mut v0, mut v1, mut v2, mut v3);
    while length >= 4 && i < length - 4 {
        v0 = dec(units[i]);
        v1 = dec(units[i + 1]);
        v2 = dec(units[i + 2]);
        v3 = dec(units[i + 3]);
        put(&mut out, &mut op, (v0 << 2) | (v1 >> 4));
        put(&mut out, &mut op, (v1 << 4) | (v2 >> 2));
        put(&mut out, &mut op, (v2 << 6) | v3);
        bad |= (v0 | v1 | v2 | v3) & INVALID;
        i += 4;
    }
    v1 = 0;
    v2 = 0;
    if length >= 1 && i < length - 1 {
        v0 = dec(units[i]);
        v1 = dec(units[i + 1]);
        put(&mut out, &mut op, (v0 << 2) | (v1 >> 4));
        bad |= (v0 | v1) & INVALID;
    }
    if length >= 2 && i < length - 2 {
        v2 = dec(units[i + 2]);
        put(&mut out, &mut op, (v1 << 4) | (v2 >> 2));
        bad |= v2 & INVALID;
    }
    if length >= 3 && i < length - 3 {
        v3 = dec(units[i + 3]);
        put(&mut out, &mut op, (v2 << 6) | v3);
        bad |= v3 & INVALID;
    }
    if bad != 0 {
        return Err("Base64Coder: incorrect characters for decoding".into());
    }
    Ok(out)
}

/// Node's `Buffer.from(s, 'base64')` (legacy decoder; identical to simdutf on valid
/// input): accepts base64url, skips invalid characters, stops at `=`.
pub fn node_b64_decode(s: &str) -> Vec<u8> {
    fn unb(c: u8) -> u8 {
        match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => 255,
        }
    }
    // Node works on latin1/utf16 code units; non-ASCII chars are invalid anyway.
    let src: Vec<u8> = s.chars().map(|c| if (c as u32) < 128 { c as u8 } else { 0xff }).collect();
    let mut size = src.len();
    if size < 2 {
        return vec![];
    }
    if src[size - 1] == b'=' {
        size -= 1;
        if src[size - 1] == b'=' {
            size -= 1;
        }
    }
    let decoded_size = {
        let rem = size % 4;
        let mut n = size / 4 * 3;
        if rem != 0 {
            if n == 0 && rem == 1 {
                n = 0;
            } else {
                n += 1 + usize::from(rem == 3);
            }
        }
        n
    };
    let dstlen = decoded_size;
    let mut dst = vec![0u8; dstlen];
    let srclen = src.len();
    let mut i = 0usize;
    let mut k = 0usize;
    // Slow path for everything (equivalent results to the fast path).
    loop {
        // Returns false when decoding stops.
        let mut lo;
        let mut hi;
        macro_rules! next {
            () => {{
                loop {
                    if i >= srclen {
                        break None;
                    }
                    let c = src[i];
                    let v = unb(c);
                    i += 1;
                    if v < 64 {
                        break Some(v);
                    }
                    if c == b'=' || i >= srclen {
                        break None;
                    }
                }
            }};
        }
        match next!() {
            Some(v) => hi = v,
            None => break,
        }
        if i >= srclen {
            break;
        }
        match next!() {
            Some(v) => lo = v,
            None => break,
        }
        if k >= dstlen {
            break;
        }
        dst[k] = ((hi & 0x3f) << 2) | ((lo & 0x30) >> 4);
        k += 1;
        if i >= srclen || k >= dstlen {
            break;
        }
        hi = lo;
        match next!() {
            Some(v) => lo = v,
            None => break,
        }
        dst[k] = ((hi & 0x0f) << 4) | ((lo & 0x3c) >> 2);
        k += 1;
        if i >= srclen || k >= dstlen {
            break;
        }
        hi = lo;
        match next!() {
            Some(v) => lo = v,
            None => break,
        }
        dst[k] = ((hi & 0x03) << 6) | (lo & 0x3f);
        k += 1;
        if i >= srclen || k >= dstlen {
            break;
        }
    }
    dst.truncate(k);
    dst
}

pub fn hex_upper(b: &[u8]) -> String {
    hex::encode_upper(b)
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

const B36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

fn to_b36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut v = Vec::new();
    while n > 0 {
        v.push(B36[(n % 36) as usize]);
        n /= 36;
    }
    v.reverse();
    String::from_utf8(v).unwrap()
}

fn pad_b36(n: u64, width: usize) -> String {
    let s = to_b36(n);
    if s.len() >= width {
        s[s.len() - width..].to_string()
    } else {
        format!("{}{}", "0".repeat(width - s.len()), s)
    }
}

static CUID_COUNTER: AtomicU32 = AtomicU32::new(0);

fn fingerprint() -> &'static str {
    use std::sync::OnceLock;
    static FP: OnceLock<String> = OnceLock::new();
    FP.get_or_init(|| {
        let pid = std::process::id() as u64;
        let host = hostname();
        let host = host.trim();
        let hsum: u64 = host.bytes().map(|b| b as u64).sum::<u64>() + host.len() as u64 + 36;
        format!("{}{}", pad_b36(pid, 2), pad_b36(hsum, 2))
    })
}

/// Prisma's `@default(cuid())` (cuid v1): `c` + time + counter + fingerprint + random.
pub fn cuid() -> String {
    let ts = to_b36(now_ms() as u64);
    let count = CUID_COUNTER.fetch_add(1, Ordering::Relaxed) % 1_679_616;
    let mut rng = rand::thread_rng();
    let r1 = rng.gen_range(0..1_679_616u64);
    let r2 = rng.gen_range(0..1_679_616u64);
    format!("c{}{}{}{}{}", ts, pad_b36(count as u64, 4), fingerprint(), pad_b36(r1, 4), pad_b36(r2, 4))
}

/// `randomKeyNaked(length)`: alphanumerics from base64 of random bytes.
pub fn random_key_naked(length: usize) -> String {
    loop {
        let mut buf = vec![0u8; length * 2];
        rand::thread_rng().fill_bytes(&mut buf);
        let s: String = b64_encode(&buf).chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if s.len() >= length {
            return s[..length].to_string();
        }
    }
}

/// engine.io / socket.io `base64id.generateId()`.
pub fn base64id() -> String {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let mut b = [0u8; 15];
    let seq = SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    b[11..15].copy_from_slice(&seq.to_be_bytes());
    rand::thread_rng().fill_bytes(&mut b[..12]);
    b64_encode(&b).replace('/', "_").replace('+', "-")
}

pub fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `os.hostname()`.
pub fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()).unwrap_or_else(|_| "localhost".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stablelib_quirks() {
        assert!(stablelib_b64_decode("AA").is_err());
        assert_eq!(stablelib_b64_decode("AAEC").unwrap(), vec![0, 1, 2]);
        assert_eq!(stablelib_b64_decode("AAECAw==").unwrap(), vec![0, 1, 2, 3]);
        assert_eq!(stablelib_b64_decode("AAECAw").unwrap(), vec![0, 1, 2, 3]);
        assert!(stablelib_b64_decode("!!!!").is_err());
        assert_eq!(stablelib_b64_decode("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn node_base64() {
        assert_eq!(node_b64_decode("AAEC"), vec![0, 1, 2]);
        assert_eq!(node_b64_decode("AAECAw=="), vec![0, 1, 2, 3]);
        assert_eq!(node_b64_decode("AAECAw"), vec![0, 1, 2, 3]);
        assert_eq!(node_b64_decode("_-8"), vec![0xff, 0xef]);
        assert_eq!(node_b64_decode("A A E C"), vec![0, 1, 2]);
        assert_eq!(node_b64_decode("A"), Vec::<u8>::new());
    }

    /// Vectors produced by Node 26 (`Buffer.from(s,'base64')`) and privacy-kit 0.0.25.
    #[test]
    fn vectors_from_node() {
        let v: &[(&str, &str, &str)] = &[
            ("AAEC", "000102", "000102"),
            ("AAECAw==", "00010203", "00010203"),
            ("AAECAw", "00010203", "00010203"),
            ("_-8", "ffef", "ERR:Base64Coder: incorrect padding"),
            ("A A E C", "000102", "ERR:Base64Coder: incorrect characters for decoding"),
            ("A", "", "ERR:Base64Coder: incorrect padding"),
            ("AB", "00", "ERR:Base64Coder: incorrect padding"),
            ("ABC", "0010", "ERR:Base64Coder: incorrect padding"),
            ("ABCD=", "001083", "001083"),
            ("AB=CD", "00", "ERR:Base64Coder: incorrect characters for decoding"),
            ("A===", "", "ERR:Base64Coder: incorrect padding"),
            ("AAAAA", "000000", "000000"),
            ("AAAAAA", "00000000", "00000000"),
            ("AAAAAAA", "0000000000", "0000000000"),
            ("Zm9v YmFy", "666f6f626172", "ERR:Base64Coder: incorrect characters for decoding"),
            ("Zm9v\nYmFy==", "666f6f626172", "ERR:Base64Coder: incorrect characters for decoding"),
            ("!!!!", "", "ERR:Base64Coder: incorrect characters for decoding"),
            ("Zg==Zg==", "66", "ERR:Base64Coder: incorrect characters for decoding"),
            ("SGVsbG8gd29ybGQ", "48656c6c6f20776f726c64", "48656c6c6f20776f726c64"),
            ("é123", "d76d", "ERR:Base64Coder: incorrect characters for decoding"),
        ];
        for (s, node, stable) in v {
            assert_eq!(hex::encode(node_b64_decode(s)), *node, "node {s:?}");
            let got = match stablelib_b64_decode(s) {
                Ok(b) => hex::encode(b),
                Err(e) => format!("ERR:{e}"),
            };
            assert_eq!(got, *stable, "stablelib {s:?}");
        }
    }

    #[test]
    fn cuid_shape() {
        let a = cuid();
        assert_eq!(a.len(), 25);
        assert!(a.starts_with('c'));
    }
}
