//! `feedRoutes.ts` and `userRoutes.ts`, with `app/feed/*` and `app/social/*`.

use crate::app::App;
use crate::events::{self, Filter};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::js;
use crate::util::{cuid, naive_to_ms};
use crate::zod::{array, boolean, coerce_number, enumeration, literal, number, object, string, union, S};
use anyhow::anyhow;
use chrono::NaiveDateTime;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use std::sync::Arc;

fn feed_body() -> S {
    union(vec![
        object(vec![("kind", literal(json!("friend_request"))), ("uid", string())]),
        object(vec![("kind", literal(json!("friend_accepted"))), ("uid", string())]),
        object(vec![("kind", literal(json!("text"))), ("text", string())]),
    ])
}

fn user_profile() -> S {
    object(vec![
        ("id", string()),
        ("firstName", string()),
        ("lastName", string().nullable()),
        (
            "avatar",
            object(vec![
                ("path", string()),
                ("url", string()),
                ("width", number().optional()),
                ("height", number().optional()),
                ("thumbhash", string().optional()),
            ])
            .nullable(),
        ),
        ("username", string()),
        ("bio", string().nullable()),
        ("status", enumeration(&["none", "requested", "pending", "friend", "rejected"])),
    ])
}

pub fn register(r: &mut Router) {
    r.get("/v1/feed")
        .auth()
        .query(
            object(vec![
                ("before", string().optional()),
                ("after", string().optional()),
                ("limit", coerce_number().int().min(1.0).max(200.0).default(json!(50))),
            ])
            .optional(),
        )
        .response(
            200,
            object(vec![
                (
                    "items",
                    array(object(vec![
                        ("id", string()),
                        ("body", feed_body()),
                        ("repeatKey", string().nullable()),
                        ("cursor", string()),
                        ("createdAt", number()),
                    ])),
                ),
                ("hasMore", boolean()),
            ]),
        )
        .handle(h!(feed));

    r.get("/v1/user/:id")
        .params(object(vec![("id", string())]))
        .response(200, object(vec![("user", user_profile())]))
        .response(404, object(vec![("error", literal(json!("User not found")))]))
        .auth()
        .handle(h!(user));

    r.get("/v1/user/search")
        .query(object(vec![("query", string())]))
        .response(200, object(vec![("users", array(user_profile()))]))
        .auth()
        .handle(h!(search));

    for (path, f) in [("/v1/friends/add", h!(friend_add)), ("/v1/friends/remove", h!(friend_remove))] {
        r.post(path)
            .body(object(vec![("uid", string())]))
            .response(200, object(vec![("user", user_profile().nullable())]))
            .response(404, object(vec![("error", literal(json!("User not found")))]))
            .auth()
            .handle(f);
    }

    r.get("/v1/friends").response(200, object(vec![("friends", array(user_profile()))])).auth().handle(h!(friends));
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/// `parseInt(s, 10)`.
fn parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(js::is_js_whitespace);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let n: f64 = digits.parse().unwrap_or(f64::NAN);
    if neg {
        -n
    } else {
        n
    }
}

/// The counter bound Prisma accepts for a BigInt filter: a finite integer in i64 range.
fn counter_bound(cursor: &str) -> anyhow::Result<i64> {
    let Some(rest) = cursor.strip_prefix("0-") else {
        anyhow::bail!("Invalid cursor format");
    };
    let n = parse_int(rest);
    if !n.is_finite() || n.abs() >= 9.223372036854775807e18 {
        anyhow::bail!("PrismaClientValidationError: invalid counter bound");
    }
    Ok(n as i64)
}

async fn feed(app: Arc<App>, req: Req) -> HResult {
    let q = |k: &str| req.query_field(k).and_then(|v| v.as_str()).map(String::from);
    let limit = req.query_field("limit").and_then(|v| v.as_f64()).unwrap_or(100.0) as i64;
    let (op, bound) = match (q("before"), q("after")) {
        (Some(b), _) => ("<", Some(counter_bound(&b)?)),
        (None, Some(a)) => (">", Some(counter_bound(&a)?)),
        _ => ("<", None),
    };
    let sql = format!(
        r#"SELECT "id","body"::text AS "body","repeatKey","counter","createdAt" FROM "UserFeedItem"
           WHERE "userId" = $1 AND ($2::bigint IS NULL OR "counter" {} $2) ORDER BY "counter" DESC LIMIT $3"#,
        op
    );
    let rows = sqlx::query(&sql).bind(&req.user_id).bind(bound).bind(limit + 1).fetch_all(&app.pool).await?;
    let has_more = rows.len() as i64 > limit;
    let items: Vec<Value> = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "body": js::parse(&r.get::<String, _>("body")).unwrap_or(Value::Null),
                "repeatKey": r.get::<Option<String>, _>("repeatKey"),
                "cursor": format!("0-{}", r.get::<i64, _>("counter")),
                "createdAt": naive_to_ms(r.get("createdAt")),
            })
        })
        .collect();
    Reply::json(json!({ "items": items, "hasMore": has_more }))
}

/// `afterTx` work collected inside a transaction, run once it commits.
type After = Vec<(String, Value)>;

/// `feedPost`: replaces the item with the same `repeatKey`, takes the next feed
/// counter, and queues the `new-feed-post` update.
async fn feed_post(c: &mut PgConnection, after: &mut After, uid: &str, body: Value, repeat_key: &str) -> anyhow::Result<()> {
    sqlx::query(r#"DELETE FROM "UserFeedItem" WHERE "userId" = $1 AND "repeatKey" = $2"#).bind(uid).bind(repeat_key).execute(&mut *c).await?;
    let now = crate::db::now();
    let counter: Option<i64> = sqlx::query_scalar(r#"UPDATE "Account" SET "feedSeq" = "feedSeq" + 1, "updatedAt" = $2 WHERE "id" = $1 RETURNING "feedSeq""#)
        .bind(uid)
        .bind(now)
        .fetch_optional(&mut *c)
        .await?;
    let counter = counter.ok_or(crate::db::RecordNotFound)?;
    let row = sqlx::query(
        r#"INSERT INTO "UserFeedItem" ("id","userId","counter","repeatKey","body","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6) RETURNING "id","body"::text AS "body","createdAt""#,
    )
    .bind(cuid())
    .bind(uid)
    .bind(counter)
    .bind(repeat_key)
    .bind(js::stringify(&body))
    .bind(crate::db::now())
    .fetch_one(&mut *c)
    .await?;
    // The update carries the row Prisma read back: jsonb key order.
    let item = json!({
        "id": row.get::<String, _>("id"),
        "body": js::parse(&row.get::<String, _>("body")).map_err(|e| anyhow!(e.message))?,
        "cursor": format!("0-{}", counter),
        "createdAt": naive_to_ms(row.get("createdAt")),
    });
    after.push((uid.to_string(), item));
    Ok(())
}

fn run_after(app: &Arc<App>, after: After) {
    if after.is_empty() {
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
        for (uid, item) in after {
            match crate::db::allocate_user_seq_pool(&app.pool, &uid).await {
                Ok(seq) => app.hub.emit_update(&uid, events::new_feed_post_update(&item, seq), Filter::UserScopedOnly, None),
                Err(e) => tracing::error!(module = "feed", "new-feed-post update failed: {}", e),
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Profiles and relationships
// ---------------------------------------------------------------------------

const ACCOUNT_SQL: &str = r#"SELECT a."id", a."firstName", a."lastName", a."username", a."avatar"::text AS "avatar", g."id" AS "gid", g."profile"::text AS "gprofile"
    FROM "Account" a LEFT JOIN "GithubUser" g ON g."id" = a."githubUserId""#;

fn json_col(r: &PgRow, k: &str) -> Value {
    r.get::<Option<String>, _>(k).and_then(|s| js::parse(&s).ok()).unwrap_or(Value::Null)
}

/// `buildUserProfile`.
fn build_profile(app: &App, r: &PgRow, status: &str) -> Value {
    let github = if r.get::<Option<String>, _>("gid").is_some() { json_col(r, "gprofile") } else { Value::Null };
    let gh = |k: &str| js::get(Some(&github), k).cloned().filter(|v| js::truthy(Some(v)));
    let avatar_json = json_col(r, "avatar");
    let avatar = if js::truthy(Some(&avatar_json)) {
        let a = Some(&avatar_json);
        let path = js::get(a, "path").cloned();
        let path_str = path.as_ref().map(js::to_js_string).unwrap_or_else(|| "undefined".into());
        let mut m = Map::new();
        if let Some(p) = path {
            m.insert("path".into(), p);
        }
        m.insert("url".into(), json!(app.files.public_url(&path_str)));
        for k in ["width", "height", "thumbhash"] {
            if let Some(v) = js::get(a, k) {
                m.insert(k.into(), v.clone());
            }
        }
        Value::Object(m)
    } else {
        Value::Null
    };
    let first: Option<String> = r.get("firstName");
    let username: Option<String> = r.get("username");
    json!({
        "id": r.get::<String, _>("id"),
        "firstName": first.filter(|s| !s.is_empty()).unwrap_or_default(),
        "lastName": r.get::<Option<String>, _>("lastName"),
        "avatar": avatar,
        "username": username.filter(|s| !s.is_empty()).map(Value::String).or_else(|| gh("login")).unwrap_or(json!("")),
        "bio": gh("bio").unwrap_or(Value::Null),
        "status": status,
    })
}

async fn find_account<'e, E: sqlx::PgExecutor<'e>>(e: E, id: &str) -> anyhow::Result<Option<PgRow>> {
    Ok(sqlx::query(&format!(r#"{} WHERE a."id" = $1 LIMIT 1"#, ACCOUNT_SQL)).bind(id).fetch_optional(e).await?)
}

async fn relationship_get<'e, E: sqlx::PgExecutor<'e>>(e: E, from: &str, to: &str) -> anyhow::Result<String> {
    let s: Option<String> =
        sqlx::query_scalar(r#"SELECT "status"::text FROM "UserRelationship" WHERE "fromUserId" = $1 AND "toUserId" = $2 LIMIT 1"#)
            .bind(from)
            .bind(to)
            .fetch_optional(e)
            .await?;
    Ok(s.unwrap_or_else(|| "none".into()))
}

/// `relationshipSet`: upsert; `acceptedAt` is set for `friend` and cleared otherwise,
/// `lastNotifiedAt` is kept.
async fn relationship_set(c: &mut PgConnection, from: &str, to: &str, status: &str) -> anyhow::Result<()> {
    let now = crate::db::now();
    let accepted = if status == "friend" { Some(now) } else { None };
    sqlx::query(
        r#"INSERT INTO "UserRelationship" ("fromUserId","toUserId","status","createdAt","updatedAt","acceptedAt","lastNotifiedAt")
           VALUES ($1,$2,$3::"RelationshipStatus",$4,$4,$5,NULL)
           ON CONFLICT ("fromUserId","toUserId") DO UPDATE SET "status" = EXCLUDED."status", "acceptedAt" = EXCLUDED."acceptedAt", "updatedAt" = EXCLUDED."updatedAt""#,
    )
    .bind(from)
    .bind(to)
    .bind(status)
    .bind(now)
    .bind(accepted)
    .execute(c)
    .await?;
    Ok(())
}

/// `shouldSendNotification`.
fn should_notify(last: Option<NaiveDateTime>, status: &str) -> bool {
    if status == "rejected" {
        return false;
    }
    match last {
        None => true,
        Some(t) => naive_to_ms(t) < crate::util::now_ms() - 24 * 60 * 60 * 1000,
    }
}

/// Posts `kind` about `other` to `user`'s feed if `user → other` allows a notification now.
async fn notify(c: &mut PgConnection, after: &mut After, user: &str, other: &str, kind: &str) -> anyhow::Result<()> {
    let rel: Option<(String, Option<NaiveDateTime>)> = sqlx::query_as(
        r#"SELECT "status"::text, "lastNotifiedAt" FROM "UserRelationship" WHERE "fromUserId" = $1 AND "toUserId" = $2"#,
    )
    .bind(user)
    .bind(other)
    .fetch_optional(&mut *c)
    .await?;
    let Some((status, last)) = rel else { return Ok(()) };
    if !should_notify(last, &status) {
        return Ok(());
    }
    let body = json!({ "kind": kind, "uid": other });
    feed_post(c, after, user, body, &format!("{}_{}", kind, other)).await?;
    let now = crate::db::now();
    crate::db::expect_row(
        sqlx::query(r#"UPDATE "UserRelationship" SET "lastNotifiedAt" = $3, "updatedAt" = $3 WHERE "fromUserId" = $1 AND "toUserId" = $2"#)
            .bind(user)
            .bind(other)
            .bind(now)
            .execute(&mut *c)
            .await?,
    )?;
    Ok(())
}

async fn user(app: Arc<App>, req: Req) -> HResult {
    let id = req.param("id");
    let Some(row) = find_account(&app.pool, &id).await? else {
        return Reply::error(404, "User not found");
    };
    let status = relationship_get(&app.pool, &req.user_id, &id).await?;
    Reply::json(json!({ "user": build_profile(&app, &row, &status) }))
}

async fn search(app: Arc<App>, req: Req) -> HResult {
    let query = req.query_field("query").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    // Prisma `startsWith` + `mode: 'insensitive'`: `ILIKE query || '%'`, wildcards not escaped.
    let rows = sqlx::query(&format!(r#"{} WHERE a."username" ILIKE $1 || '%' ORDER BY a."username" ASC LIMIT 10"#, ACCOUNT_SQL))
        .bind(&query)
        .fetch_all(&app.pool)
        .await?;
    let statuses = futures_util::future::try_join_all(rows.iter().map(|r| relationship_get(&app.pool, &req.user_id, r.get("id")))).await?;
    let users: Vec<Value> = rows.iter().zip(statuses).map(|(r, s)| build_profile(&app, r, &s)).collect();
    Reply::json(json!({ "users": users }))
}

async fn friends(app: Arc<App>, req: Req) -> HResult {
    let rels: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT "toUserId", "status"::text FROM "UserRelationship"
           WHERE "fromUserId" = $1 AND "status" IN ('friend'::"RelationshipStatus", 'pending'::"RelationshipStatus", 'requested'::"RelationshipStatus")"#,
    )
    .bind(&req.user_id)
    .fetch_all(&app.pool)
    .await?;
    let ids: Vec<String> = rels.iter().map(|r| r.0.clone()).collect();
    let rows = sqlx::query(&format!(r#"{} WHERE a."id" = ANY($1)"#, ACCOUNT_SQL)).bind(&ids).fetch_all(&app.pool).await?;
    let mut out = Vec::new();
    for (to, status) in &rels {
        if let Some(r) = rows.iter().find(|r| r.get::<String, _>("id") == *to) {
            out.push(build_profile(&app, r, status));
        }
    }
    Reply::json(json!({ "friends": out }))
}

enum Change {
    Add,
    Remove,
}

async fn friend_add(app: Arc<App>, req: Req) -> HResult {
    friend_change(app, req, Change::Add).await
}

async fn friend_remove(app: Arc<App>, req: Req) -> HResult {
    friend_change(app, req, Change::Remove).await
}

async fn friend_change(app: Arc<App>, req: Req, change: Change) -> HResult {
    let me = req.user_id.clone();
    let uid = req.body_str("uid").unwrap_or_default();
    if matches!(change, Change::Add) && me == uid {
        return Reply::json(json!({ "user": null }));
    }
    let add = matches!(change, Change::Add);
    let app2 = app.clone();
    let (profile, after) = crate::db::in_tx(&app.pool, move |c| {
        let (me, uid, app) = (me.clone(), uid.clone(), app2.clone());
        Box::pin(async move {
            let mut after: After = Vec::new();
            let current = find_account(&mut *c, &me).await?;
            let target = find_account(&mut *c, &uid).await?;
            let (Some(_), Some(target)) = (current, target) else {
                return Ok((Value::Null, after));
            };
            let mine = relationship_get(&mut *c, &me, &uid).await?;
            let theirs = relationship_get(&mut *c, &uid, &me).await?;
            let status: String = if add {
                if theirs == "requested" {
                    relationship_set(c, &uid, &me, "friend").await?;
                    relationship_set(c, &me, &uid, "friend").await?;
                    notify(c, &mut after, &me, &uid, "friend_accepted").await?;
                    notify(c, &mut after, &uid, &me, "friend_accepted").await?;
                    "friend".into()
                } else if mine == "none" || mine == "rejected" {
                    relationship_set(c, &me, &uid, "requested").await?;
                    if theirs == "none" {
                        relationship_set(c, &uid, &me, "pending").await?;
                    }
                    notify(c, &mut after, &uid, &me, "friend_request").await?;
                    "requested".into()
                } else {
                    mine
                }
            } else if mine == "requested" {
                relationship_set(c, &me, &uid, "rejected").await?;
                "rejected".into()
            } else if mine == "friend" {
                relationship_set(c, &uid, &me, "requested").await?;
                relationship_set(c, &me, &uid, "pending").await?;
                "requested".into()
            } else if mine == "pending" {
                relationship_set(c, &me, &uid, "none").await?;
                if theirs != "rejected" {
                    relationship_set(c, &uid, &me, "none").await?;
                }
                "none".into()
            } else {
                mine
            };
            Ok((build_profile(&app, &target, &status), after))
        })
    })
    .await?;
    run_after(&app, after);
    Reply::json(json!({ "user": profile }))
}
