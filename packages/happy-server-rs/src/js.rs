//! JavaScript semantics the TS server gets for free from V8: `JSON.parse` (including
//! its error messages), `JSON.stringify` (number formatting, escaping), `Number(str)`,
//! `typeof` and truthiness. Values are `serde_json::Value` with insertion order kept.

use serde_json::{Map, Number, Value};

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/// Formats a number exactly like `Number.prototype.toString()` / `JSON.stringify`.
pub fn format_number(f: f64) -> String {
    if f.is_nan() || f.is_infinite() {
        return "null".to_string(); // JSON.stringify semantics
    }
    if f == 0.0 {
        return "0".to_string();
    }
    let neg = f < 0.0;
    // Rust's `{:e}` is the shortest round-trip representation, like V8.
    let s = format!("{:e}", f.abs());
    let (mant, exp) = s.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let e = n - 1;
        if e >= 0 {
            out.push('+');
        }
        out.push_str(&e.to_string());
    }
    out
}

/// A JS number as a JSON value. `serde_json` cannot hold infinities, so +-Infinity
/// (from `JSON.parse("1e400")` or arithmetic overflow) is stored as +-f64::MAX and
/// read back as infinite by [`number_f64`]; NaN becomes null.
pub fn num(f: f64) -> Value {
    let f = if f.is_infinite() { f64::MAX.copysign(f) } else { f };
    match Number::from_f64(f) {
        Some(n) => Value::Number(n),
        None => Value::Null,
    }
}

/// The JS number a JSON number value stands for (see [`num`]).
pub fn number_f64(n: &Number) -> f64 {
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f.abs() == f64::MAX {
        f64::INFINITY.copysign(f)
    } else {
        f
    }
}

pub fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => Some(number_f64(n)),
        _ => None,
    }
}

pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `Number(string)`.
pub fn number_from_str(s: &str) -> f64 {
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        if p.is_empty() || !p.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        p.chars().fold(0.0, |acc, c| acc * r as f64 + c.to_digit(r).unwrap() as f64)
    };
    if let Some(p) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(p, 16);
    }
    if let Some(p) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(p, 8);
    }
    if let Some(p) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(p, 2);
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrDecimalLiteral: digits [. digits] [e[+-]digits], or . digits ...
    let b = body.as_bytes();
    let mut i = 0;
    let mut int_digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        int_digits += 1;
    }
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            frac_digits += 1;
        }
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if start == i {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)` for arbitrary JSON-ish values (used by `z.coerce.number()`).
/// `None` stands for `undefined`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => number_f64(n),
        Some(Value::String(s)) => number_from_str(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => to_number(Some(&Value::String(to_js_string(&a[0])))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `String(value)` for primitives and arrays (enough for coercions).
pub fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(), // inside Array.prototype.join, null becomes ""
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => format_number(number_f64(n)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(to_js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Truthiness / typeof
// ---------------------------------------------------------------------------

/// JS truthiness; `None` is `undefined`.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let f = number_f64(n);
            f != 0.0 && !f.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Property access `obj.key` with JS semantics for non-objects (strings have no
/// own enumerable props we care about; arrays only numeric keys).
pub fn get<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        Some(Value::Array(a)) => key.parse::<usize>().ok().and_then(|i| a.get(i)),
        _ => None,
    }
}

/// True when destructuring `const { x } = v` would throw (v is null/undefined).
pub fn destructure_throws(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

pub fn is_string(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(_)))
}

pub fn is_number(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(_)))
}

/// `typeof v === 'object'` (true for null, arrays, objects).
pub fn is_object_type(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)))
}

// ---------------------------------------------------------------------------
// JSON.stringify
// ---------------------------------------------------------------------------

pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v);
    out
}

pub fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&format_number(number_f64(n))),
        Value::String(s) => write_string(out, s),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, x);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            let mut first = true;
            for (k, x) in m {
                if !first {
                    out.push(',');
                }
                first = false;
                write_string(out, k);
                out.push(':');
                write_value(out, x);
            }
            out.push('}');
        }
    }
}

pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// JSON.parse with V8 error messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct JsonError {
    pub message: String,
}

struct Parser<'a> {
    src: &'a str,
    b: &'a [u8],
    i: usize,
}

/// Canonical array index ("0", "17", not "01"/"-1"), below 2^32 - 1.
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64).map(|n| n as u32)
}

/// JS own-property order: array-index keys ascending, then the rest in insertion order.
pub fn js_order(m: &mut Map<String, Value>) {
    if !m.keys().any(|k| array_index(k).is_some()) {
        return;
    }
    let mut entries: Vec<(String, Value)> = std::mem::take(m).into_iter().collect();
    // Stable: string keys keep insertion order.
    entries.sort_by_key(|(k, _)| match array_index(k) {
        Some(i) => (0u8, i),
        None => (1u8, 0),
    });
    m.extend(entries);
}

pub fn parse(src: &str) -> Result<Value, JsonError> {
    let mut p = Parser { src, b: src.as_bytes(), i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i < p.b.len() {
        return Err(p.err_at("Unexpected non-whitespace character after JSON", p.i));
    }
    Ok(v)
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    /// Position in UTF-16 code units, like V8.
    fn pos16(&self, byte_pos: usize) -> usize {
        self.src[..byte_pos.min(self.src.len())].encode_utf16().count()
    }

    fn line_col(&self, byte_pos: usize) -> (usize, usize) {
        let before = &self.src[..byte_pos.min(self.src.len())];
        let line = before.matches('\n').count() + 1;
        let col_start = before.rfind('\n').map(|x| x + 1).unwrap_or(0);
        let col = before[col_start..].encode_utf16().count() + 1;
        (line, col)
    }

    fn err_at(&self, msg: &str, byte_pos: usize) -> JsonError {
        let (l, c) = self.line_col(byte_pos);
        JsonError { message: format!("{} at position {} (line {} column {})", msg, self.pos16(byte_pos), l, c) }
    }

    fn eof(&self) -> JsonError {
        JsonError { message: "Unexpected end of JSON input".to_string() }
    }

    /// V8's "Unexpected token" message with source context.
    fn unexpected_token(&self, byte_pos: usize) -> JsonError {
        if byte_pos >= self.b.len() {
            return self.eof();
        }
        let ch = self.src[byte_pos..].chars().next().unwrap();
        if ch == '"' {
            return self.err_at("Unexpected string in JSON", byte_pos);
        }
        if ch == '-' || ch.is_ascii_digit() {
            return self.err_at("Unexpected number in JSON", byte_pos);
        }
        if matches!(self.src, "[object Object]" | "undefined" | "Infinity" | "NaN") {
            return JsonError { message: format!("\"{}\" is not valid JSON", self.src) };
        }
        let units: Vec<u16> = self.src.encode_utf16().collect();
        let pos = self.pos16(byte_pos);
        const CTX: usize = 10;
        let len = units.len();
        let msg = if len <= 40 {
            format!("Unexpected token '{}', \"{}\" is not valid JSON", ch, self.src)
        } else {
            let start = pos.saturating_sub(CTX);
            let end = (pos + CTX).min(len);
            let slice = String::from_utf16_lossy(&units[start..end]);
            let pre = if start > 0 { "..." } else { "" };
            let post = if end < len { "..." } else { "" };
            format!("Unexpected token '{}', {}\"{}\"{} is not valid JSON", ch, pre, slice, post)
        };
        JsonError { message: msg }
    }

    fn value(&mut self) -> Result<Value, JsonError> {
        if self.i >= self.b.len() {
            return Err(self.eof());
        }
        match self.b[self.i] {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Ok(Value::String(self.string()?)),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'n' => self.literal("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(self.unexpected_token(self.i)),
        }
    }

    fn literal(&mut self, word: &str, v: Value) -> Result<Value, JsonError> {
        for (k, wb) in word.bytes().enumerate() {
            let at = self.i + k;
            if at >= self.b.len() {
                return Err(self.eof());
            }
            if self.b[at] != wb {
                return Err(self.unexpected_token(at));
            }
        }
        self.i += word.len();
        Ok(v)
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
            if self.i >= self.b.len() || !self.b[self.i].is_ascii_digit() {
                return Err(self.err_at("No number after minus sign in JSON", self.i));
            }
        }
        if self.b[self.i] == b'0' {
            self.i += 1;
            if self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                return Err(self.err_at("Unexpected number in JSON", self.i));
            }
        } else {
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        if self.i < self.b.len() && self.b[self.i] == b'.' {
            self.i += 1;
            if self.i >= self.b.len() || !self.b[self.i].is_ascii_digit() {
                return Err(self.err_at("Unterminated fractional number in JSON", self.i));
            }
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        if self.i < self.b.len() && (self.b[self.i] == b'e' || self.b[self.i] == b'E') {
            self.i += 1;
            if self.i < self.b.len() && (self.b[self.i] == b'+' || self.b[self.i] == b'-') {
                self.i += 1;
            }
            if self.i >= self.b.len() || !self.b[self.i].is_ascii_digit() {
                return Err(self.err_at("Exponent part is missing a number in JSON", self.i));
            }
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        let f: f64 = self.src[start..self.i].parse().unwrap_or(f64::NAN);
        Ok(num(f))
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.i += 1; // opening quote
        let mut out = String::new();
        let mut pending_high: Option<u16> = None;
        loop {
            if self.i >= self.b.len() {
                return Err(self.err_at("Unterminated string in JSON", self.i));
            }
            let c = self.b[self.i];
            if c == b'"' {
                if pending_high.take().is_some() {
                    out.push('\u{fffd}');
                }
                self.i += 1;
                return Ok(out);
            }
            if c < 0x20 {
                return Err(self.err_at("Bad control character in string literal in JSON", self.i));
            }
            if c == b'\\' {
                self.i += 1;
                if self.i >= self.b.len() {
                    return Err(self.eof());
                }
                let e = self.b[self.i];
                let ch = match e {
                    b'"' => Some('"'),
                    b'\\' => Some('\\'),
                    b'/' => Some('/'),
                    b'b' => Some('\u{8}'),
                    b'f' => Some('\u{c}'),
                    b'n' => Some('\n'),
                    b'r' => Some('\r'),
                    b't' => Some('\t'),
                    b'u' => None,
                    _ => return Err(self.err_at("Bad escaped character in JSON", self.i)),
                };
                if let Some(ch) = ch {
                    if pending_high.take().is_some() {
                        out.push('\u{fffd}');
                    }
                    out.push(ch);
                    self.i += 1;
                    continue;
                }
                // \uXXXX
                let hex_start = self.i + 1;
                // V8 points at the first character that is not a hex digit.
                if let Some(bad) = (hex_start..hex_start + 4).find(|&k| !self.b.get(k).is_some_and(|x| x.is_ascii_hexdigit())) {
                    return Err(self.err_at("Bad Unicode escape in JSON", bad.min(self.b.len())));
                }
                let unit = u16::from_str_radix(&self.src[hex_start..hex_start + 4], 16).unwrap();
                self.i = hex_start + 4;
                if (0xD800..0xDC00).contains(&unit) {
                    if pending_high.replace(unit).is_some() {
                        out.push('\u{fffd}');
                    }
                } else if (0xDC00..0xE000).contains(&unit) {
                    match pending_high.take() {
                        Some(h) => {
                            let cp = 0x10000 + (((h as u32) - 0xD800) << 10) + ((unit as u32) - 0xDC00);
                            out.push(char::from_u32(cp).unwrap());
                        }
                        None => out.push('\u{fffd}'),
                    }
                } else {
                    if pending_high.take().is_some() {
                        out.push('\u{fffd}');
                    }
                    out.push(char::from_u32(unit as u32).unwrap());
                }
                continue;
            }
            if pending_high.take().is_some() {
                out.push('\u{fffd}');
            }
            let ch = self.src[self.i..].chars().next().unwrap();
            out.push(ch);
            self.i += ch.len_utf8();
        }
    }

    fn array(&mut self) -> Result<Value, JsonError> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.i < self.b.len() && self.b[self.i] == b']' {
            self.i += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            if self.i >= self.b.len() {
                return Err(self.err_at("Expected ',' or ']' after array element in JSON", self.i));
            }
            match self.b[self.i] {
                b',' => {
                    self.i += 1;
                }
                b']' => {
                    self.i += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.err_at("Expected ',' or ']' after array element in JSON", self.i)),
            }
        }
    }

    fn object(&mut self) -> Result<Value, JsonError> {
        self.i += 1;
        let mut m = Map::new();
        self.ws();
        if self.i < self.b.len() && self.b[self.i] == b'}' {
            self.i += 1;
            return Ok(Value::Object(m));
        }
        let mut first = true;
        loop {
            self.ws();
            if self.i >= self.b.len() || self.b[self.i] != b'"' {
                let msg = if first { "Expected property name or '}' in JSON" } else { "Expected double-quoted property name in JSON" };
                return Err(self.err_at(msg, self.i));
            }
            first = false;
            let key = self.string()?;
            self.ws();
            if self.i >= self.b.len() || self.b[self.i] != b':' {
                return Err(self.err_at("Expected ':' after property name in JSON", self.i));
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            m.insert(key, v);
            self.ws();
            if self.i >= self.b.len() {
                return Err(self.err_at("Expected ',' or '}' after property value in JSON", self.i));
            }
            match self.b[self.i] {
                b',' => {
                    self.i += 1;
                }
                b'}' => {
                    self.i += 1;
                    js_order(&mut m);
                    return Ok(Value::Object(m));
                }
                _ => return Err(self.err_at("Expected ',' or '}' after property value in JSON", self.i)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_match_v8_vectors() {
        let cases: Vec<(String, Option<String>)> = serde_json::from_str(include_str!("../testdata/json_errors.json")).unwrap();
        let mut bad = vec![];
        for (src, want) in cases {
            let got = parse(&src).err().map(|e| e.message);
            if got != want {
                bad.push(format!("{:?}: got {:?}, want {:?}", src, got, want));
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    #[test]
    fn integer_keys_first() {
        let v = parse(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"x":{"1":0,"0":1}}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"2":4,"10":2,"b":1,"a":3,"01":5,"4294967295":6,"x":{"0":1,"1":0}}"#);
    }

    #[test]
    fn numbers_format_like_js() {
        let cases = [
            (1.0, "1"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.2e-7, "1.2e-7"),
            (0.000001, "0.000001"),
            (1152921504606846976.0, "1152921504606847000"),
            (123456.789, "123456.789"),
            (-5e-324, "-5e-324"),
            (1794419715748.0, "1794419715748"),
        ];
        for (f, s) in cases {
            assert_eq!(format_number(f), s, "{f}");
        }
    }

    #[test]
    fn number_from_str_like_js() {
        assert_eq!(number_from_str(""), 0.0);
        assert_eq!(number_from_str(" 0x10 "), 16.0);
        assert_eq!(number_from_str("1e3"), 1000.0);
        assert!(number_from_str("1e").is_nan());
        assert!(number_from_str("abc").is_nan());
        assert_eq!(number_from_str(".5"), 0.5);
        assert_eq!(number_from_str("5."), 5.0);
        assert!(number_from_str(".").is_nan());
        assert_eq!(number_from_str("-Infinity"), f64::NEG_INFINITY);
        assert!(number_from_str("0x").is_nan());
    }

    #[test]
    fn parse_errors_like_v8() {
        assert_eq!(
            parse("{bad json").unwrap_err().message,
            "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
        );
        assert_eq!(parse("").unwrap_err().message, "Unexpected end of JSON input");
        assert_eq!(parse("hello").unwrap_err().message, "Unexpected token 'h', \"hello\" is not valid JSON");
        assert_eq!(
            parse("{\"a\":1} x").unwrap_err().message,
            "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)"
        );
    }

    #[test]
    fn parse_keeps_order_and_dup_position() {
        let v = parse(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"b":3,"a":2}"#);
    }
}
