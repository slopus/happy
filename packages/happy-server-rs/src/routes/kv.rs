//! `kvRoutes.ts` with `app/kv/*`.

use crate::app::App;
use crate::events::{self, Filter};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::util::{b64_encode, cuid, node_b64_decode, stablelib_b64_decode};
use crate::zod::{array, coerce_number, literal, number, object, string, S};
use anyhow::anyhow;
use serde_json::{json, Value};
use std::sync::Arc;

fn item() -> S {
    object(vec![("key", string()), ("value", string()), ("version", number())])
}

fn err(msg: &'static str) -> S {
    object(vec![("error", literal(json!(msg)))])
}

pub fn register(r: &mut Router) {
    r.get("/v1/kv/:key")
        .auth()
        .params(object(vec![("key", string())]))
        .response(200, item().nullable())
        .response(404, err("Key not found"))
        .response(500, err("Failed to get value"))
        .handle(h!(get));

    r.get("/v1/kv")
        .auth()
        .query(object(vec![
            ("prefix", string().optional()),
            ("limit", coerce_number().int().min(1.0).max(1000.0).default(json!(100))),
        ]))
        .response(200, object(vec![("items", array(item()))]))
        .response(500, err("Failed to list items"))
        .handle(h!(list));

    r.post("/v1/kv/bulk")
        .auth()
        .body(object(vec![("keys", array(string()).min(1.0).max(100.0))]))
        .response(200, object(vec![("values", array(item()))]))
        .response(500, err("Failed to get values"))
        .handle(h!(bulk));

    r.post("/v1/kv")
        .auth()
        .body(object(vec![(
            "mutations",
            array(object(vec![("key", string()), ("value", string().nullable()), ("version", number())])).min(1.0).max(100.0),
        )]))
        .response(
            200,
            object(vec![("success", literal(json!(true))), ("results", array(object(vec![("key", string()), ("version", number())])))]),
        )
        .response(
            409,
            object(vec![
                ("success", literal(json!(false))),
                (
                    "errors",
                    array(object(vec![
                        ("key", string()),
                        ("error", literal(json!("version-mismatch"))),
                        ("version", number()),
                        ("value", string().nullable()),
                    ])),
                ),
            ]),
        )
        .response(500, err("Failed to mutate values"))
        .handle(h!(mutate));
}

type Row = (String, Option<Vec<u8>>, i32);

fn item_json((key, value, version): &Row) -> Value {
    json!({ "key": key, "value": b64_encode(value.as_deref().unwrap_or_default()), "version": version })
}

fn caught(r: anyhow::Result<Reply>, log: &str, msg: &str) -> HResult {
    r.or_else(|e| {
        tracing::error!(module = "api", "Failed to {}: {}", log, e);
        Reply::error(500, msg)
    })
}

async fn get(app: Arc<App>, req: Req) -> HResult {
    let r = async {
        let row: Option<Row> = sqlx::query_as(r#"SELECT "key","value","version" FROM "UserKVStore" WHERE "accountId" = $1 AND "key" = $2"#)
            .bind(&req.user_id)
            .bind(req.param("key"))
            .fetch_optional(&app.pool)
            .await?;
        match row.filter(|r| r.1.is_some()) {
            Some(r) => Reply::json(item_json(&r)),
            None => Reply::error(404, "Key not found"),
        }
    }
    .await;
    caught(r, "get KV value", "Failed to get value")
}

async fn list(app: Arc<App>, req: Req) -> HResult {
    let r = async {
        // `if (options?.prefix)`: an empty prefix is no filter. Prisma `startsWith`
        // is `LIKE prefix || '%'` with nothing escaped: `%` and `_` stay wildcards.
        let prefix = req.query_field("prefix").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
        let limit = req.query_field("limit").and_then(|v| v.as_f64()).unwrap_or(100.0) as i64;
        let rows: Vec<Row> = sqlx::query_as(
            r#"SELECT "key","value","version" FROM "UserKVStore"
               WHERE "accountId" = $1 AND "value" IS NOT NULL AND ($2::text IS NULL OR "key" LIKE $2 || '%')
               ORDER BY "key" ASC LIMIT $3"#,
        )
        .bind(&req.user_id)
        .bind(&prefix)
        .bind(limit)
        .fetch_all(&app.pool)
        .await?;
        Reply::json(json!({ "items": rows.iter().map(item_json).collect::<Vec<_>>() }))
    }
    .await;
    caught(r, "list KV items", "Failed to list items")
}

async fn bulk(app: Arc<App>, req: Req) -> HResult {
    let r = async {
        let keys: Vec<String> = req
            .body_field("keys")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let rows: Vec<Row> = sqlx::query_as(
            r#"SELECT "key","value","version" FROM "UserKVStore" WHERE "accountId" = $1 AND "key" = ANY($2) AND "value" IS NOT NULL"#,
        )
        .bind(&req.user_id)
        .bind(&keys)
        .fetch_all(&app.pool)
        .await?;
        Reply::json(json!({ "values": rows.iter().map(item_json).collect::<Vec<_>>() }))
    }
    .await;
    caught(r, "bulk get KV values", "Failed to get values")
}

struct Mutation {
    key: String,
    value: Option<String>,
    version: f64,
}

enum Outcome {
    Mismatch(Vec<Value>),
    Done(Vec<Value>, Vec<Value>),
}

async fn mutate(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let muts: Arc<Vec<Mutation>> = Arc::new(
        req.body_field("mutations")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|m| Mutation {
                        key: m["key"].as_str().unwrap_or_default().to_string(),
                        value: m["value"].as_str().map(String::from),
                        version: m["version"].as_f64().unwrap_or(f64::NAN),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    );
    let r = async {
        let (u, ms) = (uid.clone(), muts.clone());
        let outcome = crate::db::in_tx(&app.pool, move |c| {
            let (u, ms) = (u.clone(), ms.clone());
            Box::pin(async move {
                let mut errors = Vec::new();
                for m in ms.iter() {
                    let existing: Option<(Option<Vec<u8>>, i32)> =
                        sqlx::query_as(r#"SELECT "value","version" FROM "UserKVStore" WHERE "accountId" = $1 AND "key" = $2"#)
                            .bind(&u)
                            .bind(&m.key)
                            .fetch_optional(&mut *c)
                            .await?;
                    let current = existing.as_ref().map(|e| e.1 as f64).unwrap_or(-1.0);
                    if current != m.version {
                        // `existing?.value ? encode : null`: an empty Buffer is truthy.
                        let value = existing.and_then(|e| e.0).map(|v| b64_encode(&v));
                        errors.push(json!({ "key": m.key, "error": "version-mismatch", "version": current, "value": value }));
                    }
                }
                if !errors.is_empty() {
                    return Ok(Outcome::Mismatch(errors));
                }
                let (mut results, mut changes) = (Vec::new(), Vec::new());
                for m in ms.iter() {
                    let version: i32 = if m.version == -1.0 {
                        // Create: `Buffer.from(value, 'base64')` (lenient).
                        let value = m.value.as_deref().filter(|s| !s.is_empty()).map(node_b64_decode);
                        let now = crate::db::now();
                        sqlx::query_scalar(
                            r#"INSERT INTO "UserKVStore" ("id","accountId","key","value","version","createdAt","updatedAt")
                               VALUES ($1,$2,$3,$4,0,$5,$5) RETURNING "version""#,
                        )
                        .bind(cuid())
                        .bind(&u)
                        .bind(&m.key)
                        .bind(value)
                        .bind(now)
                        .fetch_one(&mut *c)
                        .await?
                    } else {
                        // Update: `privacyKit.decodeBase64` (throws on bad input).
                        let value = match m.value.as_deref().filter(|s| !s.is_empty()) {
                            Some(s) => Some(stablelib_b64_decode(s).map_err(|e| anyhow!(e))?),
                            None => None,
                        };
                        let next = m.version + 1.0;
                        let next = if next.fract() == 0.0 && next.abs() <= i32::MAX as f64 { next as i32 } else { anyhow::bail!("Value out of range for the type: integer") };
                        let v: Option<i32> = sqlx::query_scalar(
                            r#"UPDATE "UserKVStore" SET "value" = $3, "version" = $4, "updatedAt" = $5 WHERE "accountId" = $1 AND "key" = $2 RETURNING "version""#,
                        )
                        .bind(&u)
                        .bind(&m.key)
                        .bind(value)
                        .bind(next)
                        .bind(crate::db::now())
                        .fetch_optional(&mut *c)
                        .await?;
                        v.ok_or(crate::db::RecordNotFound)?
                    };
                    results.push(json!({ "key": m.key, "version": version }));
                    changes.push(json!({ "key": m.key, "value": m.value, "version": version }));
                }
                Ok(Outcome::Done(results, changes))
            })
        })
        .await?;
        match outcome {
            Outcome::Mismatch(errors) => Reply::code(409, json!({ "success": false, "errors": errors })),
            Outcome::Done(results, changes) => {
                // afterTx: not awaited by the response.
                let app = app.clone();
                let uid = uid.clone();
                tokio::spawn(async move {
                    match crate::db::allocate_user_seq_pool(&app.pool, &uid).await {
                        Ok(seq) => app.hub.emit_update(&uid, events::kv_batch_update(changes, seq), Filter::UserScopedOnly, None),
                        Err(e) => tracing::error!(module = "kv", "kv-batch-update failed: {}", e),
                    }
                });
                Reply::json(json!({ "success": true, "results": results }))
            }
        }
    }
    .await;
    caught(r, "mutate KV values", "Failed to mutate values")
}
