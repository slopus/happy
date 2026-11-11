//! Socket.IO v5 packet encoding (the Engine.IO transport arrives in Phase 2).

use serde_json::Value;

/// A Socket.IO EVENT packet on the default namespace, without the Engine.IO
/// message prefix: `2["event",...args]`.
pub fn encode_event(event: &str, args: &[Value]) -> String {
    let mut arr = Vec::with_capacity(args.len() + 1);
    arr.push(Value::String(event.to_string()));
    arr.extend(args.iter().cloned());
    format!("2{}", crate::js::stringify(&Value::Array(arr)))
}
