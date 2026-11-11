//! `artifactsRoutes.ts`. Every handler has a catch-all that answers 500 with its
//! own message, so decode, overflow and P2025 failures all end there.

use crate::app::App;
use crate::events::{self, Filter};
use crate::h;
use crate::handlers::find_artifact;
use crate::http::{HResult, Reply, Req, Router};
use crate::models::{Artifact, ARTIFACT_COLS};
use crate::util::{b64_encode, naive_to_ms, stablelib_b64_decode};
use crate::zod::{array, literal, number, object, string, union, S};
use anyhow::anyhow;
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn full() -> S {
    object(vec![
        ("id", string()),
        ("header", string()),
        ("headerVersion", number()),
        ("body", string()),
        ("bodyVersion", number()),
        ("dataEncryptionKey", string()),
        ("seq", number()),
        ("createdAt", number()),
        ("updatedAt", number()),
    ])
}

fn err(msg: &'static str) -> S {
    object(vec![("error", literal(json!(msg)))])
}

pub fn register(r: &mut Router) {
    r.get("/v1/artifacts")
        .auth()
        .response(
            200,
            array(object(vec![
                ("id", string()),
                ("header", string()),
                ("headerVersion", number()),
                ("dataEncryptionKey", string()),
                ("seq", number()),
                ("createdAt", number()),
                ("updatedAt", number()),
            ])),
        )
        .response(500, err("Failed to get artifacts"))
        .handle(h!(list));

    r.get("/v1/artifacts/:id")
        .auth()
        .params(object(vec![("id", string())]))
        .response(200, full())
        .response(404, err("Artifact not found"))
        .response(500, err("Failed to get artifact"))
        .handle(h!(get));

    r.post("/v1/artifacts")
        .auth()
        .body(object(vec![("id", string().uuid()), ("header", string()), ("body", string()), ("dataEncryptionKey", string())]))
        .response(200, full())
        .response(409, err("Artifact with this ID already exists for another account"))
        .response(500, err("Failed to create artifact"))
        .handle(h!(create));

    r.post("/v1/artifacts/:id")
        .auth()
        .params(object(vec![("id", string())]))
        .body(object(vec![
            ("header", string().optional()),
            ("expectedHeaderVersion", number().int().min(0.0).optional()),
            ("body", string().optional()),
            ("expectedBodyVersion", number().int().min(0.0).optional()),
        ]))
        .response(
            200,
            union(vec![
                object(vec![("success", literal(json!(true))), ("headerVersion", number().optional()), ("bodyVersion", number().optional())]),
                object(vec![
                    ("success", literal(json!(false))),
                    ("error", literal(json!("version-mismatch"))),
                    ("currentHeaderVersion", number().optional()),
                    ("currentBodyVersion", number().optional()),
                    ("currentHeader", string().optional()),
                    ("currentBody", string().optional()),
                ]),
            ]),
        )
        .response(404, err("Artifact not found"))
        .response(500, err("Failed to update artifact"))
        .handle(h!(update));

    r.delete("/v1/artifacts/:id")
        .auth()
        .params(object(vec![("id", string())]))
        .response(200, object(vec![("success", literal(json!(true)))]))
        .response(404, err("Artifact not found"))
        .response(500, err("Failed to delete artifact"))
        .handle(h!(delete));
}

fn b64(s: &str) -> anyhow::Result<Vec<u8>> {
    stablelib_b64_decode(s).map_err(|e| anyhow!(e))
}

/// The handler's `catch`: log and answer 500 with the route's message.
fn caught(r: anyhow::Result<Reply>, what: &'static str) -> HResult {
    r.or_else(|e| {
        tracing::error!(module = "api", "Failed to {}: {}", what, e);
        Reply::error(500, &format!("Failed to {}", what))
    })
}

async fn list(app: Arc<App>, req: Req) -> HResult {
    let r = async {
        let rows: Vec<(String, Vec<u8>, i32, Vec<u8>, i32, chrono::NaiveDateTime, chrono::NaiveDateTime)> = sqlx::query_as(
            r#"SELECT "id","header","headerVersion","dataEncryptionKey","seq","createdAt","updatedAt" FROM "Artifact"
               WHERE "accountId" = $1 ORDER BY "updatedAt" DESC LIMIT 200"#,
        )
        .bind(&req.user_id)
        .fetch_all(&app.pool)
        .await?;
        let out: Vec<Value> = rows
            .iter()
            .map(|(id, h, hv, k, seq, c, u)| {
                json!({
                    "id": id,
                    "header": b64_encode(h),
                    "headerVersion": hv,
                    "dataEncryptionKey": b64_encode(k),
                    "seq": seq,
                    "createdAt": naive_to_ms(*c),
                    "updatedAt": naive_to_ms(*u),
                })
            })
            .collect();
        Reply::json(Value::Array(out))
    }
    .await;
    caught(r, "get artifacts")
}

async fn get(app: Arc<App>, req: Req) -> HResult {
    let r = async {
        match find_artifact(&app, &req.param("id"), &req.user_id).await? {
            Some(a) => Reply::json(a.http_json()),
            None => Reply::error(404, "Artifact not found"),
        }
    }
    .await;
    caught(r, "get artifact")
}

async fn create(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let r = async {
        let id = req.body_str("id").unwrap_or_default();
        let existing = sqlx::query(&format!(r#"SELECT {} FROM "Artifact" WHERE "id" = $1"#, ARTIFACT_COLS)).bind(&id).fetch_optional(&app.pool).await?;
        if let Some(row) = existing {
            let a = Artifact::from_row(&row);
            if a.account_id != uid {
                return Reply::error(409, "Artifact with this ID already exists for another account");
            }
            tracing::info!(module = "api", "Found existing artifact");
            return Reply::json(a.http_json());
        }
        tracing::info!(module = "api", "Creating new artifact");
        let h = b64(&req.body_str("header").unwrap_or_default())?;
        let b = b64(&req.body_str("body").unwrap_or_default())?;
        let k = b64(&req.body_str("dataEncryptionKey").unwrap_or_default())?;
        let row = sqlx::query(&format!(
            r#"INSERT INTO "Artifact" ("id","accountId","header","headerVersion","body","bodyVersion","dataEncryptionKey","seq","createdAt","updatedAt")
               VALUES ($1,$2,$3,1,$4,1,$5,0,$6,$6) RETURNING {}"#,
            ARTIFACT_COLS
        ))
        .bind(&id)
        .bind(&uid)
        .bind(&h)
        .bind(&b)
        .bind(&k)
        .bind(crate::db::now())
        .fetch_one(&app.pool)
        .await?;
        let a = Artifact::from_row(&row);
        let seq = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
        app.hub.emit_update(&uid, events::new_artifact_update(&a, seq), Filter::UserScopedOnly, None);
        Reply::json(a.http_json())
    }
    .await;
    caught(r, "create artifact")
}

async fn update(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let r = async {
        let id = req.param("id");
        let header = req.body_str("header");
        let body = req.body_str("body");
        let ehv = req.body_field("expectedHeaderVersion").and_then(|v| v.as_f64());
        let ebv = req.body_field("expectedBodyVersion").and_then(|v| v.as_f64());
        let Some(cur) = find_artifact(&app, &id, &uid).await? else {
            return Reply::error(404, "Artifact not found");
        };
        let hm = header.is_some() && ehv.is_some_and(|v| cur.header_version as f64 != v);
        let bm = body.is_some() && ebv.is_some_and(|v| cur.body_version as f64 != v);
        if hm || bm {
            let mut o = Map::new();
            o.insert("success".into(), json!(false));
            o.insert("error".into(), json!("version-mismatch"));
            if hm {
                o.insert("currentHeaderVersion".into(), json!(cur.header_version));
                o.insert("currentHeader".into(), json!(b64_encode(&cur.header)));
            }
            if bm {
                o.insert("currentBodyVersion".into(), json!(cur.body_version));
                o.insert("currentBody".into(), json!(b64_encode(&cur.body)));
            }
            return Reply::json(Value::Object(o));
        }
        // Versions equal the stored Int columns here, so `+ 1` overflowing i32 is
        // the value Prisma would reject.
        let bump = |v: i32| v.checked_add(1).ok_or_else(|| anyhow!("Value out of range for the type: integer"));
        let hu = match (&header, ehv) {
            (Some(h), Some(_)) => Some((b64(h)?, h.clone(), bump(cur.header_version)?)),
            _ => None,
        };
        let bu = match (&body, ebv) {
            (Some(b), Some(_)) => Some((b64(b)?, b.clone(), bump(cur.body_version)?)),
            _ => None,
        };
        let seq = bump(cur.seq)?;
        let mut sets = String::from(r#""updatedAt" = $2, "seq" = $3"#);
        let mut i = 4;
        if hu.is_some() {
            sets.push_str(&format!(r#", "header" = ${}, "headerVersion" = ${}"#, i, i + 1));
            i += 2;
        }
        if bu.is_some() {
            sets.push_str(&format!(r#", "body" = ${}, "bodyVersion" = ${}"#, i, i + 1));
        }
        let sql = format!(r#"UPDATE "Artifact" SET {} WHERE "id" = $1"#, sets);
        let mut q = sqlx::query(&sql).bind(&id).bind(crate::db::now()).bind(seq);
        if let Some((bytes, _, v)) = &hu {
            q = q.bind(bytes).bind(v);
        }
        if let Some((bytes, _, v)) = &bu {
            q = q.bind(bytes).bind(v);
        }
        crate::db::expect_row(q.execute(&app.pool).await?)?;

        let useq = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
        let hv = hu.as_ref().map(|(_, s, v)| json!({"value": s, "version": v}));
        let bv = bu.as_ref().map(|(_, s, v)| json!({"value": s, "version": v}));
        app.hub.emit_update(&uid, events::update_artifact_update(&id, useq, hv, bv), Filter::UserScopedOnly, None);

        let mut o = Map::new();
        o.insert("success".into(), json!(true));
        if let Some((_, _, v)) = &hu {
            o.insert("headerVersion".into(), json!(v));
        }
        if let Some((_, _, v)) = &bu {
            o.insert("bodyVersion".into(), json!(v));
        }
        Reply::json(Value::Object(o))
    }
    .await;
    caught(r, "update artifact")
}

async fn delete(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let r = async {
        let id = req.param("id");
        if find_artifact(&app, &id, &uid).await?.is_none() {
            return Reply::error(404, "Artifact not found");
        }
        crate::db::expect_row(sqlx::query(r#"DELETE FROM "Artifact" WHERE "id" = $1"#).bind(&id).execute(&app.pool).await?)?;
        let seq = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
        app.hub.emit_update(&uid, events::simple_update(seq, "delete-artifact", "artifactId", &id), Filter::UserScopedOnly, None);
        Reply::json(json!({"success": true}))
    }
    .await;
    caught(r, "delete artifact")
}
