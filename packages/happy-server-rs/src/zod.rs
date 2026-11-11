//! A small zod v4 look-alike: the schema shapes the TS routes use, with zod's
//! issue messages, path reporting, coercion, stripping of unknown keys, output in
//! schema key order, and its "abort on invalid_type" refinement rule.

use crate::js;
use regex::Regex;
use serde_json::{Map, Value};

#[derive(Clone)]
pub enum StrCheck {
    Min(usize),
    Max(usize),
    Regex(Regex, String),
    Uuid,
}

#[derive(Clone)]
pub enum S {
    Str(Vec<StrCheck>),
    Num { coerce: bool, int: bool, checks: Vec<NumCheck> },
    Bool,
    Lit(Value),
    Enum(Vec<&'static str>),
    Obj { fields: Vec<(&'static str, S)>, strict: bool },
    Arr { item: Box<S>, min: Option<usize>, max: Option<usize> },
    Opt(Box<S>),
    Nullable(Box<S>),
    Nullish(Box<S>),
    Default(Box<S>, Value),
    Any,
    Record,
    Union(Vec<S>),
    Refine(Box<S>, fn(&Value) -> bool, &'static str),
}

#[derive(Clone, Copy)]
pub enum NumCheck {
    Gte(f64),
    Gt(f64),
    Lte(f64),
}

#[derive(Debug, Clone)]
pub struct Issue {
    pub path: Vec<String>,
    pub message: String,
    /// zod "aborts" (skips refinements) after non-continuable issues.
    pub fatal: bool,
}

pub fn string() -> S {
    S::Str(vec![])
}
pub fn number() -> S {
    S::Num { coerce: false, int: false, checks: vec![] }
}
pub fn coerce_number() -> S {
    S::Num { coerce: true, int: false, checks: vec![] }
}
pub fn boolean() -> S {
    S::Bool
}
pub fn literal(v: Value) -> S {
    S::Lit(v)
}
pub fn enumeration(v: &[&'static str]) -> S {
    S::Enum(v.to_vec())
}
pub fn object(fields: Vec<(&'static str, S)>) -> S {
    S::Obj { fields, strict: false }
}
pub fn array(item: S) -> S {
    S::Arr { item: Box::new(item), min: None, max: None }
}
pub fn any() -> S {
    S::Any
}
pub fn record() -> S {
    S::Record
}
pub fn union(v: Vec<S>) -> S {
    S::Union(v)
}

impl S {
    pub fn min(self, n: f64) -> S {
        match self {
            S::Str(mut c) => {
                c.push(StrCheck::Min(n as usize));
                S::Str(c)
            }
            S::Num { coerce, int, mut checks } => {
                checks.push(NumCheck::Gte(n));
                S::Num { coerce, int, checks }
            }
            S::Arr { item, max, .. } => S::Arr { item, min: Some(n as usize), max },
            other => other,
        }
    }
    pub fn max(self, n: f64) -> S {
        match self {
            S::Str(mut c) => {
                c.push(StrCheck::Max(n as usize));
                S::Str(c)
            }
            S::Num { coerce, int, mut checks } => {
                checks.push(NumCheck::Lte(n));
                S::Num { coerce, int, checks }
            }
            S::Arr { item, min, .. } => S::Arr { item, min, max: Some(n as usize) },
            other => other,
        }
    }
    pub fn positive(self) -> S {
        match self {
            S::Num { coerce, int, mut checks } => {
                checks.push(NumCheck::Gt(0.0));
                S::Num { coerce, int, checks }
            }
            other => other,
        }
    }
    pub fn int(self) -> S {
        match self {
            S::Num { coerce, checks, .. } => S::Num { coerce, int: true, checks },
            other => other,
        }
    }
    pub fn regex(self, re: &str) -> S {
        match self {
            S::Str(mut c) => {
                // `re` is the JS source incl. flags, e.g. "/^[a-z]+$/i".
                let (body, flags) = re[1..].rsplit_once('/').unwrap();
                let pat = if flags.contains('i') { format!("(?i){}", body) } else { body.to_string() };
                c.push(StrCheck::Regex(Regex::new(&pat).unwrap(), re.to_string()));
                S::Str(c)
            }
            other => other,
        }
    }
    pub fn uuid(self) -> S {
        match self {
            S::Str(mut c) => {
                c.push(StrCheck::Uuid);
                S::Str(c)
            }
            other => other,
        }
    }
    pub fn optional(self) -> S {
        S::Opt(Box::new(self))
    }
    pub fn nullable(self) -> S {
        S::Nullable(Box::new(self))
    }
    pub fn nullish(self) -> S {
        S::Nullish(Box::new(self))
    }
    pub fn default(self, v: Value) -> S {
        S::Default(Box::new(self), v)
    }
    pub fn strict(self) -> S {
        match self {
            S::Obj { fields, .. } => S::Obj { fields, strict: true },
            other => other,
        }
    }
    pub fn refine(self, f: fn(&Value) -> bool, msg: &'static str) -> S {
        S::Refine(Box::new(self), f, msg)
    }

    /// `schema.safeParse(v)`; `None` input/output is `undefined`.
    pub fn parse(&self, v: Option<&Value>) -> Result<Option<Value>, Vec<Issue>> {
        let mut issues = Vec::new();
        let mut path = Vec::new();
        let out = run(self, v, &mut path, &mut issues);
        if issues.is_empty() {
            Ok(out)
        } else {
            Err(issues)
        }
    }
}

fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(n)) => {
            if n.as_f64().map(|f| f.is_nan()).unwrap_or(false) {
                "NaN"
            } else {
                "number"
            }
        }
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn push(issues: &mut Vec<Issue>, path: &[String], message: String, fatal: bool) {
    issues.push(Issue { path: path.to_vec(), message, fatal });
}

fn invalid_type(issues: &mut Vec<Issue>, path: &[String], expected: &str, v: Option<&Value>) {
    push(issues, path, format!("Invalid input: expected {}, received {}", expected, received(v)), true);
}

fn fmt_num(f: f64) -> String {
    js::format_number(f)
}

const MAX_SAFE: f64 = 9007199254740991.0;

fn run(s: &S, v: Option<&Value>, path: &mut Vec<String>, issues: &mut Vec<Issue>) -> Option<Value> {
    match s {
        S::Any => v.cloned(),
        S::Opt(inner) => {
            if v.is_none() {
                None
            } else {
                run(inner, v, path, issues)
            }
        }
        S::Nullable(inner) => {
            if matches!(v, Some(Value::Null)) {
                Some(Value::Null)
            } else {
                run(inner, v, path, issues)
            }
        }
        S::Nullish(inner) => match v {
            None => None,
            Some(Value::Null) => Some(Value::Null),
            _ => run(inner, v, path, issues),
        },
        S::Default(inner, d) => {
            if v.is_none() {
                Some(d.clone())
            } else {
                run(inner, v, path, issues)
            }
        }
        S::Str(checks) => {
            let st = match v {
                Some(Value::String(st)) => st,
                _ => {
                    invalid_type(issues, path, "string", v);
                    return None;
                }
            };
            let len = st.encode_utf16().count();
            for c in checks {
                match c {
                    StrCheck::Min(n) if len < *n => push(
                        issues,
                        path,
                        format!("Too small: expected string to have >={} characters", n),
                        false,
                    ),
                    StrCheck::Max(n) if len > *n => push(
                        issues,
                        path,
                        format!("Too big: expected string to have <={} characters", n),
                        false,
                    ),
                    StrCheck::Regex(re, src) if !re.is_match(st) => {
                        push(issues, path, format!("Invalid string: must match pattern {}", src), false)
                    }
                    StrCheck::Uuid if !is_zod_uuid(st) => push(issues, path, "Invalid UUID".to_string(), false),
                    _ => {}
                }
            }
            Some(Value::String(st.clone()))
        }
        S::Num { coerce, int, checks } => {
            let f = if *coerce {
                js::to_number(v)
            } else {
                match v {
                    Some(Value::Number(n)) => js::number_f64(n),
                    _ => {
                        invalid_type(issues, path, "number", v);
                        return None;
                    }
                }
            };
            if f.is_nan() {
                push(issues, path, "Invalid input: expected number, received NaN".into(), true);
                return None;
            }
            if f.is_infinite() {
                push(issues, path, "Invalid input: expected number, received number".into(), true);
                return None;
            }
            if *int {
                if f.fract() != 0.0 {
                    push(issues, path, "Invalid input: expected int, received number".into(), true);
                    return None;
                }
                if f > MAX_SAFE {
                    push(issues, path, format!("Too big: expected int to be <={}", fmt_num(MAX_SAFE)), true);
                    return None;
                }
                if f < -MAX_SAFE {
                    push(issues, path, format!("Too small: expected int to be >={}", fmt_num(-MAX_SAFE)), true);
                    return None;
                }
            }
            for c in checks {
                match *c {
                    NumCheck::Gte(m) if f < m => {
                        push(issues, path, format!("Too small: expected number to be >={}", fmt_num(m)), false)
                    }
                    NumCheck::Gt(m) if f <= m => {
                        push(issues, path, format!("Too small: expected number to be >{}", fmt_num(m)), false)
                    }
                    NumCheck::Lte(m) if f > m => {
                        push(issues, path, format!("Too big: expected number to be <={}", fmt_num(m)), false)
                    }
                    _ => {}
                }
            }
            Some(js::num(f))
        }
        S::Bool => match v {
            Some(Value::Bool(b)) => Some(Value::Bool(*b)),
            _ => {
                invalid_type(issues, path, "boolean", v);
                None
            }
        },
        S::Lit(l) => {
            if v == Some(l) {
                v.cloned()
            } else {
                push(issues, path, format!("Invalid input: expected {}", js::stringify(l)), true);
                None
            }
        }
        S::Enum(opts) => match v {
            Some(Value::String(st)) if opts.iter().any(|o| o == st) => v.cloned(),
            _ => {
                let list = opts.iter().map(|o| format!("\"{}\"", o)).collect::<Vec<_>>().join("|");
                push(issues, path, format!("Invalid option: expected one of {}", list), true);
                None
            }
        },
        S::Record => match v {
            Some(Value::Object(m)) => Some(Value::Object(m.clone())),
            _ => {
                invalid_type(issues, path, "record", v);
                None
            }
        },
        S::Arr { item, min, max } => {
            let a = match v {
                Some(Value::Array(a)) => a,
                _ => {
                    invalid_type(issues, path, "array", v);
                    return None;
                }
            };
            let mut out = Vec::with_capacity(a.len());
            for (i, x) in a.iter().enumerate() {
                path.push(i.to_string());
                let r = run(item, Some(x), path, issues);
                path.pop();
                out.push(r.unwrap_or(Value::Null));
            }
            if let Some(m) = min {
                if a.len() < *m {
                    push(issues, path, format!("Too small: expected array to have >={} items", m), false);
                }
            }
            if let Some(m) = max {
                if a.len() > *m {
                    push(issues, path, format!("Too big: expected array to have <={} items", m), false);
                }
            }
            Some(Value::Array(out))
        }
        S::Obj { fields, strict } => {
            let m = match v {
                Some(Value::Object(m)) => m,
                _ => {
                    invalid_type(issues, path, "object", v);
                    return None;
                }
            };
            let mut out = Map::new();
            for (k, fs) in fields {
                path.push(k.to_string());
                let r = run(fs, m.get(*k), path, issues);
                path.pop();
                if let Some(r) = r {
                    out.insert(k.to_string(), r);
                }
            }
            if *strict {
                let extra: Vec<&String> = m.keys().filter(|k| !fields.iter().any(|(f, _)| f == k)).collect();
                if !extra.is_empty() {
                    let list = extra.iter().map(|k| format!("\"{}\"", k)).collect::<Vec<_>>().join(", ");
                    let word = if extra.len() == 1 { "key" } else { "keys" };
                    push(issues, path, format!("Unrecognized {}: {}", word, list), false);
                }
            }
            Some(Value::Object(out))
        }
        S::Union(opts) => {
            for o in opts {
                let mut tmp = Vec::new();
                let r = run(o, v, path, &mut tmp);
                if tmp.is_empty() {
                    return r;
                }
            }
            push(issues, path, "Invalid input".into(), true);
            None
        }
        S::Refine(inner, f, msg) => {
            let before = issues.len();
            let r = run(inner, v, path, issues);
            let aborted = issues[before..].iter().any(|i| i.fatal);
            if !aborted {
                if let Some(val) = &r {
                    if !f(val) {
                        push(issues, path, msg.to_string(), false);
                    }
                }
            }
            r
        }
    }
}

pub fn is_zod_uuid(s: &str) -> bool {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$").unwrap()
    })
    .is_match(s)
}

/// fastify-type-provider-zod + Fastify's default schemaErrorFormatter.
pub fn format_issues(context: &str, issues: &[Issue]) -> String {
    issues
        .iter()
        .map(|i| format!("{}/{} {}", context, i.path.join("/"), i.message))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msgs(s: &S, v: Value) -> Vec<String> {
        match s.parse(Some(&v)) {
            Ok(_) => vec![],
            Err(i) => i.into_iter().map(|i| format!("{}|{}", i.path.join("/"), i.message)).collect(),
        }
    }

    #[test]
    fn matches_zod_messages() {
        let q = object(vec![
            ("after_seq", coerce_number().int().min(0.0).optional()),
            ("before_seq", coerce_number().int().min(1.0).optional()),
            ("limit", coerce_number().int().min(1.0).max(500.0).default(json!(100))),
        ])
        .refine(|d| !(d.get("after_seq").is_some() && d.get("before_seq").is_some()), "mx");
        assert_eq!(msgs(&q, json!({"after_seq":"x","before_seq":"1"})), vec!["after_seq|Invalid input: expected number, received NaN"]);
        assert_eq!(msgs(&q, json!({"after_seq":"1","before_seq":"1"})), vec!["|mx"]);
        assert_eq!(
            msgs(&q, json!({"limit":"0","after_seq":"1","before_seq":"2"})),
            vec!["limit|Too small: expected number to be >=1", "|mx"]
        );
        let o = object(vec![("p", string())]).strict();
        assert_eq!(msgs(&o, json!({"p":"a","x":1,"y":2})), vec!["|Unrecognized keys: \"x\", \"y\""]);
        assert_eq!(msgs(&number().int(), json!(1152921504606846976.0)), vec!["|Too big: expected int to be <=9007199254740991"]);
        assert_eq!(msgs(&enumeration(&["openai", "anthropic"]), json!("x")), vec!["|Invalid option: expected one of \"openai\"|\"anthropic\""]);
        let m = object(vec![("m", array(object(vec![("content", string()), ("localId", string().min(1.0))])).min(1.0))]);
        assert_eq!(
            msgs(&m, json!({"m":[{"content":1,"localId":""},3]})),
            vec![
                "m/0/content|Invalid input: expected string, received number",
                "m/0/localId|Too small: expected string to have >=1 characters",
                "m/1|Invalid input: expected object, received number"
            ]
        );
        assert_eq!(coerce_number().int().parse(Some(&json!(" 0x10 "))).unwrap(), Some(json!(16.0)));
        let out = object(vec![("b", number()), ("a", number())]).parse(Some(&json!({"a":1,"b":2,"x":3}))).unwrap().unwrap();
        assert_eq!(js::stringify(&out), r#"{"b":2,"a":1}"#);
    }
}
