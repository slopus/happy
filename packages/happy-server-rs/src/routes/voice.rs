//! `voiceRoutes.ts`: ElevenLabs conversation tokens behind a 30-day usage cap.

use crate::app::App;
use crate::fetch;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::js;
use crate::zod::{enumeration, literal, number, object, string, union};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashSet;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

const VOICE_HARD_LIMIT_SECONDS: f64 = 7200.0;
const VOICE_USAGE_PAGE_SIZE: u32 = 100;

pub fn register(r: &mut Router) {
    let granted = object(vec![
        ("allowed", literal(json!(true))),
        ("conversationToken", string()),
        ("conversationId", string()),
        ("agentId", string()),
        ("elevenUserId", string()),
        ("usedSeconds", number()),
        ("limitSeconds", number()),
    ]);
    let denied = object(vec![
        ("allowed", literal(json!(false))),
        ("reason", enumeration(&["voice_hard_limit_reached", "subscription_required", "voice_conversation_limit_reached"])),
        ("usedSeconds", number()),
        ("limitSeconds", number()),
        ("agentId", string()),
    ]);
    r.post("/v1/voice/conversations")
        .auth()
        .body(object(vec![("agentId", string())]))
        .response(200, union(vec![granted, denied]))
        .response(500, object(vec![("error", string())]))
        .handle(h!(conversations));

    r.get("/v1/voice/usage")
        .auth()
        .response(
            200,
            object(vec![
                ("usedSeconds", number()),
                ("limitSeconds", number()),
                ("conversationCount", number()),
                ("conversationLimit", number()),
                ("elevenUserId", string()),
            ]),
        )
        .response(500, object(vec![("error", string())]))
        .handle(h!(usage));
}

/// `u_` + base64url(HMAC-SHA256(master secret, user id)).
fn eleven_user_id(app: &App, user_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(app.config.master_secret.as_bytes()).expect("hmac key");
    mac.update(user_id.as_bytes());
    format!("u_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// `getVoiceUsage`: pages of the user's conversations from the last 30 days, all
/// under one 15 s deadline, stopping once the cap is reached.
async fn voice_usage(app: &App, key: &str, eleven_user_id: &str) -> anyhow::Result<(f64, usize)> {
    let since = crate::util::now_ms().div_euclid(1000) - 30 * 86400;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let (mut used, mut count) = (0.0f64, 0usize);
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    loop {
        let mut query = vec![
            ("user_id", eleven_user_id.to_string()),
            ("call_start_after_unix", since.to_string()),
            ("page_size", VOICE_USAGE_PAGE_SIZE.to_string()),
        ];
        if let Some(c) = &cursor {
            query.push(("cursor", c.clone()));
        }
        let qs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", k, js::form_urlencode(v))).collect();
        let url = format!("{}/conversations?{}", app.config.elevenlabs_api, qs.join("&"));
        let data = tokio::time::timeout_at(deadline, async {
            let res = fetch::CLIENT.get(url).header("xi-api-key", fetch::header_value(key)?).send().await?;
            if !res.status().is_success() {
                anyhow::bail!("ElevenLabs conversations query failed: {}", res.status().as_u16());
            }
            fetch::json(res).await
        })
        .await
        .map_err(|_| anyhow::anyhow!("The operation was aborted due to timeout"))??;

        let (Some(Value::Array(conversations)), Some(Value::Bool(has_more))) = (js::get(Some(&data), "conversations"), js::get(Some(&data), "has_more"))
        else {
            anyhow::bail!("Invalid ElevenLabs conversation history");
        };
        for c in conversations {
            if c.is_null() {
                anyhow::bail!("Cannot read properties of null (reading 'call_duration_secs')");
            }
            let duration = match js::get(Some(c), "call_duration_secs") {
                None | Some(Value::Null) => 0.0,
                Some(Value::Number(n)) => js::number_f64(n),
                Some(_) => f64::NAN,
            };
            if !duration.is_finite() || duration < 0.0 {
                anyhow::bail!("Invalid ElevenLabs conversation duration");
            }
            used += duration;
        }
        count += conversations.len();

        if used >= VOICE_HARD_LIMIT_SECONDS || !has_more {
            break;
        }
        match js::get(Some(&data), "next_cursor") {
            Some(Value::String(c)) if !c.is_empty() && !seen.contains(c) => {
                seen.insert(c.clone());
                cursor = Some(c.clone());
            }
            _ => anyhow::bail!("Invalid ElevenLabs conversation history cursor"),
        }
    }
    Ok((used, count))
}

static CONVERSATION_ID: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"conv_[a-zA-Z0-9]+").unwrap());

async fn conversations(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let agent_id = req.body_str("agentId").unwrap_or_default();
    tracing::info!(module = "voice", "Voice token request from user {}", uid);
    let Some(key) = app.config.elevenlabs_api_key.clone() else {
        return Reply::error(500, "ELEVENLABS_API_KEY not configured");
    };
    let eleven = eleven_user_id(&app, &uid);
    let (used, count) = match voice_usage(&app, &key, &eleven).await {
        Ok(u) => u,
        Err(e) => {
            tracing::info!(module = "voice", "Failed to get voice usage for user {}: {:#}", uid, e);
            return Reply::error(500, "Failed to get voice usage");
        }
    };
    tracing::info!(module = "voice", "User {}: {}s used, {} convos (hard={}s)", uid, js::format_number(used), count, VOICE_HARD_LIMIT_SECONDS);
    if used >= VOICE_HARD_LIMIT_SECONDS {
        return Reply::json(json!({
            "allowed": false,
            "reason": "voice_hard_limit_reached",
            "usedSeconds": js::num(used),
            "limitSeconds": js::num(VOICE_HARD_LIMIT_SECONDS),
            "agentId": agent_id,
        }));
    }

    // The agent id goes into the URL unencoded, as in the TS template string.
    let url = format!("{}/conversation/token?agent_id={}&participant_name={}", app.config.elevenlabs_api, agent_id, eleven);
    match conversation_token(&url, &key).await {
        Ok(Token::Failed(status)) => {
            tracing::info!(module = "voice", "Failed to get conversation token for user {}: {}", uid, status);
            Reply::error(500, "Failed to get voice credentials")
        }
        Ok(Token::NoConversation) => {
            tracing::info!(module = "voice", "No conversation_id in JWT for user {}", uid);
            Reply::error(500, "Failed to get conversation ID")
        }
        Ok(Token::Granted(token, conversation_id)) => {
            tracing::info!(module = "voice", "Voice token issued for user {}, conv={}", uid, conversation_id);
            Reply::json(json!({
                "allowed": true,
                "conversationToken": token,
                "conversationId": conversation_id,
                "agentId": agent_id,
                "elevenUserId": eleven,
                "usedSeconds": js::num(used),
                "limitSeconds": js::num(VOICE_HARD_LIMIT_SECONDS),
            }))
        }
        Err(e) => {
            tracing::info!(module = "voice", "ElevenLabs request error for user {}: {:#}", uid, e);
            Reply::error(500, "Failed to get voice credentials")
        }
    }
}

enum Token {
    Failed(u16),
    NoConversation,
    Granted(String, String),
}

/// The token request; `Err` wherever the TS code throws.
async fn conversation_token(url: &str, key: &str) -> anyhow::Result<Token> {
    let res = fetch::CLIENT.get(url).header("xi-api-key", fetch::header_value(key)?).send().await?;
    if !res.status().is_success() {
        return Ok(Token::Failed(res.status().as_u16()));
    }
    let data = fetch::json(res).await?;
    if js::destructure_throws(Some(&data)) {
        anyhow::bail!("Cannot destructure property 'token'");
    }
    let Some(Value::String(token)) = js::get(Some(&data), "token") else {
        anyhow::bail!("conversationToken.split is not a function");
    };
    // `Buffer.from(token.split('.')[1], 'base64')` throws on undefined.
    let Some(part) = token.split('.').nth(1) else { anyhow::bail!("The first argument must be of type string") };
    let decoded = crate::util::node_b64_decode(part);
    let payload = js::parse(&String::from_utf8_lossy(&decoded)).map_err(|e| anyhow::anyhow!(e.message))?;
    if payload.is_null() {
        anyhow::bail!("Cannot read properties of null (reading 'video')");
    }
    // `(jwtPayload.video?.room || '').match(...)`: only strings have `match`.
    let room = js::get(js::get(Some(&payload), "video"), "room");
    let room = if js::truthy(room) { room.cloned().unwrap_or(Value::Null) } else { json!("") };
    let Value::String(room) = room else { anyhow::bail!("match is not a function") };
    Ok(match CONVERSATION_ID.find(&room) {
        Some(m) => Token::Granted(token.clone(), m.as_str().to_string()),
        None => Token::NoConversation,
    })
}

async fn usage(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let Some(key) = app.config.elevenlabs_api_key.clone() else {
        return Reply::error(500, "ELEVENLABS_API_KEY not configured");
    };
    let eleven = eleven_user_id(&app, &uid);
    match voice_usage(&app, &key, &eleven).await {
        Ok((used, count)) => Reply::json(json!({
            "usedSeconds": js::num(used),
            "limitSeconds": js::num(VOICE_HARD_LIMIT_SECONDS),
            "conversationCount": count,
            "conversationLimit": VOICE_USAGE_PAGE_SIZE,
            "elevenUserId": eleven,
        })),
        Err(e) => {
            tracing::info!(module = "voice", "Failed to get voice usage for user {}: {:#}", uid, e);
            Reply::error(500, "Failed to get voice usage")
        }
    }
}
