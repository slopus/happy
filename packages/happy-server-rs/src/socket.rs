//! Socket.IO v5 packets as socket.io-parser 4.2 reads and writes them, quirks
//! included: whitespace counts as a type digit and as an ack-id digit, a binary
//! packet announcing zero attachments leaves the reconstructor armed, and
//! payloads are checked with `isPayloadValid`.
//!
//! A Node `Buffer` inside a JSON value is carried as a one-key object
//! `{"\u0000buffer:<per-process nonce>": "<base64>"}`; [`encode`] turns those
//! into binary attachments and [`buffers_to_json`] into what `JSON.stringify`
//! writes. The key never leaves the process, so clients cannot forge one.

use crate::js;
use crate::util::{b64_encode, node_b64_decode};
use serde_json::{json, Map, Value};

pub const CONNECT: u8 = 0;
pub const DISCONNECT: u8 = 1;
pub const EVENT: u8 = 2;
pub const ACK: u8 = 3;
pub const CONNECT_ERROR: u8 = 4;
pub const BINARY_EVENT: u8 = 5;
pub const BINARY_ACK: u8 = 6;

const RESERVED_EVENTS: [&str; 6] = ["connect", "connect_error", "disconnect", "disconnecting", "newListener", "removeListener"];

static BUF_KEY: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    use rand::RngCore;
    let mut n = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut n);
    format!("\u{0}buffer:{}", n.iter().map(|b| format!("{:02x}", b)).collect::<String>())
});

#[derive(Debug, Clone)]
pub struct Packet {
    pub ty: u8,
    pub nsp: String,
    /// `Number(...)` of the id digits; may be NaN or fractional for odd input.
    pub id: Option<f64>,
    pub data: Option<Value>,
    pub attachments: f64,
}

pub fn buffer_value(bytes: &[u8]) -> Value {
    let mut m = Map::new();
    m.insert(BUF_KEY.clone(), Value::String(b64_encode(bytes)));
    Value::Object(m)
}

pub fn as_buffer(v: &Value) -> Option<Vec<u8>> {
    match v {
        Value::Object(m) if m.len() == 1 => match m.get(BUF_KEY.as_str()) {
            Some(Value::String(s)) => Some(node_b64_decode(s)),
            _ => None,
        },
        _ => None,
    }
}

pub fn has_binary(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.iter().any(has_binary),
        Value::Object(m) => as_buffer(v).is_some() || m.values().any(has_binary),
        _ => false,
    }
}

/// How Prisma stores a value in a Json column: Buffers become base64 strings.
pub fn buffers_to_json(v: &Value) -> Value {
    if !has_binary(v) {
        return v.clone();
    }
    match v {
        Value::Array(a) => Value::Array(a.iter().map(buffers_to_json).collect()),
        Value::Object(m) => match as_buffer(v) {
            Some(b) => Value::String(b64_encode(&b)),
            None => Value::Object(m.iter().map(|(k, x)| (k.clone(), buffers_to_json(x))).collect()),
        },
        _ => v.clone(),
    }
}

fn deconstruct(v: &Value, bufs: &mut Vec<Vec<u8>>) -> Value {
    if let Some(b) = as_buffer(v) {
        let n = bufs.len();
        bufs.push(b);
        return json!({"_placeholder": true, "num": n});
    }
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| deconstruct(x, bufs)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), deconstruct(x, bufs))).collect()),
        _ => v.clone(),
    }
}

/// `String(id)` for an ack id.
pub fn id_string(id: f64) -> String {
    if id.is_nan() {
        "NaN".into()
    } else if id.is_infinite() {
        if id > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else {
        js::format_number(id)
    }
}

/// `Encoder.encode`: the text packet plus binary attachments.
pub fn encode(ty: u8, nsp: &str, id: Option<f64>, data: Option<&Value>) -> (String, Vec<Vec<u8>>) {
    let mut ty = ty;
    let mut bufs = Vec::new();
    let mut owned = None;
    if (ty == EVENT || ty == ACK) && data.map(has_binary).unwrap_or(false) {
        ty = if ty == EVENT { BINARY_EVENT } else { BINARY_ACK };
        owned = Some(deconstruct(data.unwrap(), &mut bufs));
    }
    let data = owned.as_ref().or(data);
    let mut s = String::new();
    s.push((b'0' + ty) as char);
    if ty == BINARY_EVENT || ty == BINARY_ACK {
        s.push_str(&bufs.len().to_string());
        s.push('-');
    }
    if !nsp.is_empty() && nsp != "/" {
        s.push_str(nsp);
        s.push(',');
    }
    if let Some(id) = id {
        s.push_str(&id_string(id));
    }
    if let Some(d) = data {
        if !d.is_null() {
            js::write_value(&mut s, d);
        }
    }
    (s, bufs)
}

/// `2["event",...args]` on the default namespace.
pub fn encode_event(event: &str, args: &[Value]) -> (String, Vec<Vec<u8>>) {
    let mut arr = Vec::with_capacity(args.len() + 1);
    arr.push(Value::String(event.to_string()));
    arr.extend(args.iter().cloned());
    encode(EVENT, "/", None, Some(&Value::Array(arr)))
}

/// `Number(c) == c` for a one-character string: digits and JS whitespace.
fn id_char(c: char) -> bool {
    c.is_ascii_digit() || js::is_js_whitespace(c)
}

fn is_object(v: &Value) -> bool {
    matches!(v, Value::Object(_))
}

fn payload_valid(ty: u8, p: &Value) -> bool {
    match ty {
        CONNECT => is_object(p),
        DISCONNECT => false,
        CONNECT_ERROR => matches!(p, Value::String(_)) || is_object(p),
        EVENT | BINARY_EVENT => match p {
            Value::Array(a) => match a.first() {
                Some(Value::Number(_)) => true,
                Some(Value::String(s)) => !RESERVED_EVENTS.contains(&s.as_str()),
                _ => false,
            },
            _ => false,
        },
        ACK | BINARY_ACK => matches!(p, Value::Array(_)),
        _ => false,
    }
}

/// `Decoder.decodeString`.
pub fn decode_string(s: &str) -> Result<Packet, String> {
    let c: Vec<char> = s.chars().collect();
    let len = c.len();
    let at = |i: usize| -> Option<char> { c.get(i).copied() };
    let ty = match at(0) {
        None => 0.0,
        Some(ch) => js::number_from_str(&ch.to_string()),
    };
    if !(ty >= 0.0 && ty <= 6.0 && ty.fract() == 0.0) {
        return Err(format!("unknown packet type {}", id_string(ty)));
    }
    let ty = ty as u8;
    let mut p = Packet { ty, nsp: "/".into(), id: None, data: None, attachments: 0.0 };
    let mut i = 0usize;
    if ty == BINARY_EVENT || ty == BINARY_ACK {
        let start = i + 1;
        loop {
            i += 1;
            if at(i) == Some('-') || i == len {
                break;
            }
        }
        let buf: String = c[start.min(len)..i.min(len)].iter().collect();
        let n = js::number_from_str(&buf);
        if n.is_nan() || at(i) != Some('-') {
            return Err("Illegal attachments".into());
        }
        p.attachments = n;
    }
    if at(i + 1) == Some('/') {
        let start = i + 1;
        loop {
            i += 1;
            if at(i) == Some(',') || i == len {
                break;
            }
        }
        p.nsp = c[start..i.min(len)].iter().collect();
    }
    if let Some(next) = at(i + 1) {
        if id_char(next) {
            let start = i + 1;
            loop {
                i += 1;
                match at(i) {
                    Some(ch) if !id_char(ch) => {
                        i -= 1;
                        break;
                    }
                    _ => {}
                }
                if i == len {
                    break;
                }
            }
            let digits: String = c[start..(i + 1).min(len)].iter().collect();
            p.id = Some(js::number_from_str(&digits));
        }
    }
    i += 1;
    if i < len {
        let rest: String = c[i..].iter().collect();
        match js::parse(&rest) {
            Ok(v) if payload_valid(ty, &v) => p.data = Some(v),
            _ => return Err("invalid payload".into()),
        }
    }
    Ok(p)
}

/// `_reconstructPacket`: placeholders become the attached buffers.
pub fn reconstruct(v: Value, bufs: &[Vec<u8>]) -> Result<Value, String> {
    match v {
        Value::Object(m) if m.get("_placeholder") == Some(&Value::Bool(true)) => match m.get("num").and_then(js::as_f64) {
            Some(n) if n >= 0.0 && n < bufs.len() as f64 => {
                if n.fract() == 0.0 {
                    Ok(buffer_value(&bufs[n as usize]))
                } else {
                    Ok(Value::Null) // `buffers[0.5]` is undefined
                }
            }
            _ => Err("illegal attachments".into()),
        },
        Value::Array(a) => Ok(Value::Array(a.into_iter().map(|x| reconstruct(x, bufs)).collect::<Result<_, _>>()?)),
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, x) in m {
                out.insert(k, reconstruct(x, bufs)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_like_socket_io_parser() {
        let p = decode_string(r#"2["a",1]"#).unwrap();
        assert_eq!((p.ty, p.nsp.as_str(), p.id), (2, "/", None));
        let p = decode_string(r#"212["a"]"#).unwrap();
        assert_eq!(p.id, Some(12.0));
        let p = decode_string(r#"2/x,3["a"]"#).unwrap();
        assert_eq!((p.nsp.as_str(), p.id), ("/x", Some(3.0)));
        let p = decode_string("0").unwrap();
        assert_eq!((p.ty, p.data.is_none()), (0, true));
        assert_eq!(decode_string("").unwrap().ty, 0);
        assert_eq!(decode_string(" ").unwrap().ty, 0);
        let p = decode_string(r#"21 2["a"]"#).unwrap();
        assert!(p.id.unwrap().is_nan());
        let p = decode_string(r#"51-["a",{"_placeholder":true,"num":0}]"#).unwrap();
        assert_eq!((p.ty, p.attachments), (5, 1.0));
        assert_eq!(decode_string(r#"5-["a"]"#).unwrap().attachments, 0.0);
        assert!(decode_string(r#"5x-["a"]"#).is_err());
        assert!(decode_string(r#"2["connect"]"#).is_err());
        assert!(decode_string(r#"2[]"#).is_err());
        assert!(decode_string(r#"1{}"#).is_err());
        assert!(decode_string(r#"0[]"#).is_err());
        assert!(decode_string(r#"2{"#).is_err());
        assert!(decode_string("7").is_err());
        assert!(decode_string("x").is_err());
        let p = decode_string(r#"3"#).unwrap();
        assert_eq!((p.ty, p.id), (3, None));
        let p = decode_string(r#"2/x"#).unwrap();
        assert_eq!(p.nsp, "/x");
    }

    #[test]
    fn encode_binary() {
        let v = json!(["e", {"a": buffer_value(&[1, 2]), "b": [buffer_value(&[3])]}]);
        let (s, b) = encode(EVENT, "/", Some(4.0), Some(&v));
        assert_eq!(s, r#"52-4["e",{"a":{"_placeholder":true,"num":0},"b":[{"_placeholder":true,"num":1}]}]"#);
        assert_eq!(b, vec![vec![1, 2], vec![3]]);
        let (s, _) = encode(CONNECT_ERROR, "/x", None, Some(&json!({"message": "Invalid namespace"})));
        assert_eq!(s, r#"4/x,{"message":"Invalid namespace"}"#);
        assert_eq!(js::stringify(&buffers_to_json(&json!([buffer_value(&[7, 8, 9])]))), r#"["BwgJ"]"#);
    }

    #[test]
    fn client_json_is_never_a_buffer() {
        let forged = decode_string(r#"2["e",{"\u0000buffer":"AQI="}]"#).unwrap().data.unwrap();
        assert!(!has_binary(&forged));
        assert_eq!(encode(EVENT, "/", None, Some(&forged)).0, r#"2["e",{"\u0000buffer":"AQI="}]"#);
    }
}
