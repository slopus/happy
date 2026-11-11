//! `machinesRoutes.ts`.

use crate::app::App;
use crate::events::{self, Filter};
use crate::h;
use crate::handlers::find_machine;
use crate::http::{HResult, Reply, Req, Router};
use crate::models::{Machine, MACHINE_COLS};
use crate::util::node_b64_decode;
use crate::zod::{object, string};
use serde_json::json;
use std::sync::Arc;

pub fn register(r: &mut Router) {
    r.post("/v1/machines")
        .auth()
        .body(object(vec![
            ("id", string()),
            ("metadata", string()),
            ("daemonState", string().optional()),
            ("dataEncryptionKey", string().nullish()),
        ]))
        .handle(h!(create));

    r.get("/v1/machines").auth().handle(h!(list));

    r.get("/v1/machines/:id").auth().params(object(vec![("id", string())])).handle(h!(get));

    r.delete("/v1/machines/:id").auth().params(object(vec![("id", string())])).handle(h!(delete));
}

async fn create(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let id = req.body_str("id").unwrap_or_default();
    let metadata = req.body_str("metadata").unwrap_or_default();
    // `daemonState || null`, `dataEncryptionKey ? … : undefined`: empty strings count as absent.
    let daemon_state = req.body_str("daemonState").filter(|s| !s.is_empty());
    let dek = req.body_str("dataEncryptionKey").filter(|s| !s.is_empty()).map(|s| node_b64_decode(&s));

    if let Some(machine) = find_machine(&app, &uid, &id).await? {
        tracing::info!(module = "machines", "Found existing machine");
        return Reply::json(json!({ "machine": machine.json(false) }));
    }

    tracing::info!(module = "machines", "Creating new machine");
    let now = crate::db::now();
    let created = sqlx::query(&format!(
        r#"INSERT INTO "Machine" ("id","accountId","metadata","metadataVersion","daemonState","daemonStateVersion","dataEncryptionKey","seq","active","lastActiveAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,1,$4,$5,$6,0,false,$7,$7,$7) RETURNING {}"#,
        MACHINE_COLS
    ))
    .bind(&id)
    .bind(&uid)
    .bind(&metadata)
    .bind(&daemon_state)
    .bind(if daemon_state.is_some() { 1 } else { 0 })
    .bind(dek)
    .bind(now)
    .fetch_one(&app.pool)
    .await
    .map_err(anyhow::Error::from);
    let machine = match created {
        Ok(row) => Machine::from_row(&row),
        Err(e) if crate::db::is_unique_violation(&e) => {
            tracing::info!(module = "machines", "Machine id belongs to another account");
            return Reply::code(409, json!({"error": "Machine id is registered to another account", "code": "machine_id_taken"}));
        }
        Err(e) => return Err(e),
    };

    let seq1 = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
    let seq2 = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
    app.hub.emit_update(&uid, events::new_machine_update(&machine, seq1), Filter::UserScopedOnly, None);
    let meta = json!({ "version": 1, "value": metadata });
    app.hub.emit_update(&uid, events::update_machine_update(&machine.id, seq2, Some(meta), None), Filter::Machine(&machine.id), None);

    Reply::json(json!({ "machine": machine.json(false) }))
}

async fn list(app: Arc<App>, req: Req) -> HResult {
    let rows = sqlx::query(&format!(r#"SELECT {} FROM "Machine" WHERE "accountId" = $1 ORDER BY "lastActiveAt" DESC"#, MACHINE_COLS))
        .bind(&req.user_id)
        .fetch_all(&app.pool)
        .await?;
    Reply::json(json!(rows.iter().map(|r| Machine::from_row(r).json(true)).collect::<Vec<_>>()))
}

async fn get(app: Arc<App>, req: Req) -> HResult {
    match find_machine(&app, &req.user_id, &req.param("id")).await? {
        Some(m) => Reply::json(json!({ "machine": m.json(true) })),
        None => Reply::error(404, "Machine not found"),
    }
}

async fn delete(app: Arc<App>, req: Req) -> HResult {
    let (uid, id) = (req.user_id.clone(), req.param("id"));
    let (u, m) = (uid.clone(), id.clone());
    let deleted = crate::db::in_tx(&app.pool, move |c| {
        let (u, m) = (u.clone(), m.clone());
        Box::pin(async move {
            let found: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Machine" WHERE "accountId" = $1 AND "id" = $2 LIMIT 1"#)
                .bind(&u)
                .bind(&m)
                .fetch_optional(&mut *c)
                .await?;
            if found.is_none() {
                return Ok(false);
            }
            sqlx::query(r#"DELETE FROM "AccessKey" WHERE "accountId" = $1 AND "machineId" = $2"#).bind(&u).bind(&m).execute(&mut *c).await?;
            crate::db::expect_row(sqlx::query(r#"DELETE FROM "Machine" WHERE "id" = $1"#).bind(&m).execute(&mut *c).await?)?;
            Ok(true)
        })
    })
    .await?;
    if !deleted {
        return Reply::error(404, "Machine not found");
    }
    // afterTx: not awaited by the response.
    let app2 = app.clone();
    tokio::spawn(async move {
        match crate::db::allocate_user_seq_pool(&app2.pool, &uid).await {
            Ok(seq) => {
                app2.hub.emit_update(&uid, events::simple_update(seq, "delete-machine", "machineId", &id), Filter::UserScopedOnly, None);
                tracing::info!(module = "machines", "Machine deleted");
            }
            // TS: an unhandled rejection here terminates the process.
            Err(e) => tracing::error!(module = "machines", "delete-machine update failed: {}", e),
        }
    });
    Reply::json(json!({"success": true}))
}
