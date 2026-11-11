//! Row types for the Prisma tables, plus the JSON projections shared by routes.

use crate::events::session_avatar;
use crate::util::{b64_encode, naive_to_ms};
use chrono::NaiveDateTime;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

pub const SESSION_COLS: &str = r#""id","tag","accountId","projectId","avatarRef","avatarPreview","avatarVersion","metadata","metadataVersion","agentState","agentStateVersion","dataEncryptionKey","seq","active","lastActiveAt","createdAt","updatedAt""#;

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub tag: String,
    pub account_id: String,
    pub project_id: Option<String>,
    pub avatar_ref: Option<String>,
    pub avatar_preview: Option<String>,
    pub avatar_version: i32,
    pub metadata: String,
    pub metadata_version: i32,
    pub agent_state: Option<String>,
    pub agent_state_version: i32,
    pub data_encryption_key: Option<Vec<u8>>,
    pub seq: i32,
    pub active: bool,
    pub last_active_at: NaiveDateTime,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl Session {
    pub fn from_row(r: &PgRow) -> Session {
        Session {
            id: r.get("id"),
            tag: r.get("tag"),
            account_id: r.get("accountId"),
            project_id: r.get("projectId"),
            avatar_ref: r.get("avatarRef"),
            avatar_preview: r.get("avatarPreview"),
            avatar_version: r.get("avatarVersion"),
            metadata: r.get("metadata"),
            metadata_version: r.get("metadataVersion"),
            agent_state: r.get("agentState"),
            agent_state_version: r.get("agentStateVersion"),
            data_encryption_key: r.get("dataEncryptionKey"),
            seq: r.get("seq"),
            active: r.get("active"),
            last_active_at: r.get("lastActiveAt"),
            created_at: r.get("createdAt"),
            updated_at: r.get("updatedAt"),
        }
    }

    pub fn dek(&self) -> Value {
        self.data_encryption_key.as_ref().map(|b| Value::String(b64_encode(b))).unwrap_or(Value::Null)
    }

    pub fn avatar(&self) -> Value {
        session_avatar(&self.avatar_ref, &self.avatar_preview, self.avatar_version)
    }

    /// `/v1/sessions` list item (key order of sessionRoutes.ts).
    pub fn list_json(&self, last_message: bool) -> Value {
        let mut v = json!({
            "id": self.id,
            "seq": self.seq,
            "createdAt": naive_to_ms(self.created_at),
            "updatedAt": naive_to_ms(self.updated_at),
            "active": self.active,
            "activeAt": naive_to_ms(self.last_active_at),
            "metadata": self.metadata,
            "metadataVersion": self.metadata_version,
            "agentState": self.agent_state,
            "agentStateVersion": self.agent_state_version,
            "dataEncryptionKey": self.dek(),
            "projectId": self.project_id,
            "avatar": self.avatar(),
            "avatarVersion": self.avatar_version,
        });
        if last_message {
            v["lastMessage"] = Value::Null;
        }
        v
    }

    /// `POST /v1/sessions` response `session` object.
    pub fn create_json(&self) -> Value {
        json!({
            "id": self.id,
            "seq": self.seq,
            "metadata": self.metadata,
            "metadataVersion": self.metadata_version,
            "agentState": self.agent_state,
            "agentStateVersion": self.agent_state_version,
            "dataEncryptionKey": self.dek(),
            "projectId": self.project_id,
            "avatar": self.avatar(),
            "avatarVersion": self.avatar_version,
            "active": self.active,
            "activeAt": naive_to_ms(self.last_active_at),
            "createdAt": naive_to_ms(self.created_at),
            "updatedAt": naive_to_ms(self.updated_at),
            "lastMessage": null,
        })
    }
}

pub const MACHINE_COLS: &str = r#""id","accountId","metadata","metadataVersion","daemonState","daemonStateVersion","dataEncryptionKey","seq","active","lastActiveAt","createdAt","updatedAt""#;

#[derive(Clone, Debug)]
pub struct Machine {
    pub id: String,
    pub account_id: String,
    pub metadata: String,
    pub metadata_version: i32,
    pub daemon_state: Option<String>,
    pub daemon_state_version: i32,
    pub data_encryption_key: Option<Vec<u8>>,
    pub seq: i32,
    pub active: bool,
    pub last_active_at: NaiveDateTime,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl Machine {
    pub fn from_row(r: &PgRow) -> Machine {
        Machine {
            id: r.get("id"),
            account_id: r.get("accountId"),
            metadata: r.get("metadata"),
            metadata_version: r.get("metadataVersion"),
            daemon_state: r.get("daemonState"),
            daemon_state_version: r.get("daemonStateVersion"),
            data_encryption_key: r.get("dataEncryptionKey"),
            seq: r.get("seq"),
            active: r.get("active"),
            last_active_at: r.get("lastActiveAt"),
            created_at: r.get("createdAt"),
            updated_at: r.get("updatedAt"),
        }
    }

    pub fn json(&self, with_seq: bool) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("metadata".into(), json!(self.metadata));
        m.insert("metadataVersion".into(), json!(self.metadata_version));
        m.insert("daemonState".into(), json!(self.daemon_state));
        m.insert("daemonStateVersion".into(), json!(self.daemon_state_version));
        m.insert(
            "dataEncryptionKey".into(),
            self.data_encryption_key.as_ref().map(|b| Value::String(b64_encode(b))).unwrap_or(Value::Null),
        );
        if with_seq {
            m.insert("seq".into(), json!(self.seq));
        }
        m.insert("active".into(), json!(self.active));
        m.insert("activeAt".into(), json!(naive_to_ms(self.last_active_at)));
        m.insert("createdAt".into(), json!(naive_to_ms(self.created_at)));
        m.insert("updatedAt".into(), json!(naive_to_ms(self.updated_at)));
        Value::Object(m)
    }
}

pub const ARTIFACT_COLS: &str = r#""id","accountId","header","headerVersion","body","bodyVersion","dataEncryptionKey","seq","createdAt","updatedAt""#;

#[derive(Clone, Debug)]
pub struct Artifact {
    pub id: String,
    pub account_id: String,
    pub header: Vec<u8>,
    pub header_version: i32,
    pub body: Vec<u8>,
    pub body_version: i32,
    pub data_encryption_key: Vec<u8>,
    pub seq: i32,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl Artifact {
    pub fn from_row(r: &PgRow) -> Artifact {
        Artifact {
            id: r.get("id"),
            account_id: r.get("accountId"),
            header: r.get("header"),
            header_version: r.get("headerVersion"),
            body: r.get("body"),
            body_version: r.get("bodyVersion"),
            data_encryption_key: r.get("dataEncryptionKey"),
            seq: r.get("seq"),
            created_at: r.get("createdAt"),
            updated_at: r.get("updatedAt"),
        }
    }

    /// Full artifact for HTTP (includes dataEncryptionKey).
    pub fn http_json(&self) -> Value {
        json!({
            "id": self.id,
            "header": b64_encode(&self.header),
            "headerVersion": self.header_version,
            "body": b64_encode(&self.body),
            "bodyVersion": self.body_version,
            "dataEncryptionKey": b64_encode(&self.data_encryption_key),
            "seq": self.seq,
            "createdAt": naive_to_ms(self.created_at),
            "updatedAt": naive_to_ms(self.updated_at),
        })
    }

    /// Socket artifact (no dataEncryptionKey).
    pub fn socket_json(&self) -> Value {
        json!({
            "id": self.id,
            "header": b64_encode(&self.header),
            "headerVersion": self.header_version,
            "body": b64_encode(&self.body),
            "bodyVersion": self.body_version,
            "seq": self.seq,
            "createdAt": naive_to_ms(self.created_at),
            "updatedAt": naive_to_ms(self.updated_at),
        })
    }
}

pub const PROJECT_COLS: &str = r#""id","accountId","externalId","metadata","metadataVersion","dataEncryptionKey","avatarRef","avatarPreview","avatarVersion","seq","createdAt","updatedAt""#;

#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub external_id: String,
    pub metadata: String,
    pub metadata_version: i32,
    pub data_encryption_key: Option<Vec<u8>>,
    pub avatar_ref: Option<String>,
    pub avatar_preview: Option<String>,
    pub avatar_version: i32,
    pub seq: i32,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl Project {
    pub fn from_row(r: &PgRow) -> Project {
        Project {
            id: r.get("id"),
            external_id: r.get("externalId"),
            metadata: r.get("metadata"),
            metadata_version: r.get("metadataVersion"),
            data_encryption_key: r.get("dataEncryptionKey"),
            avatar_ref: r.get("avatarRef"),
            avatar_preview: r.get("avatarPreview"),
            avatar_version: r.get("avatarVersion"),
            seq: r.get("seq"),
            created_at: r.get("createdAt"),
            updated_at: r.get("updatedAt"),
        }
    }

    /// `serializeProject`.
    pub fn json(&self) -> Value {
        let avatar = match &self.avatar_ref {
            Some(r) if !r.is_empty() => json!({
                "ref": r,
                "preview": self.avatar_preview.clone().unwrap_or_default(),
                "version": self.avatar_version,
            }),
            _ => Value::Null,
        };
        json!({
            "id": self.id,
            "externalId": self.external_id,
            "metadata": self.metadata,
            "metadataVersion": self.metadata_version,
            "dataEncryptionKey": self.data_encryption_key.as_ref().map(|b| b64_encode(b)),
            "avatar": avatar,
            "seq": self.seq,
            "createdAt": naive_to_ms(self.created_at),
            "updatedAt": naive_to_ms(self.updated_at),
        })
    }
}

/// A session message as returned by the message routes.
#[derive(Clone, Debug)]
pub struct Message {
    pub id: String,
    pub seq: i32,
    pub local_id: Option<String>,
    /// `content` exactly as Postgres renders the jsonb (`content::text`).
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Message {
    /// `{id, seq, content, localId, createdAt, updatedAt}`.
    pub fn json(&self) -> Value {
        let content = crate::js::parse(&self.content).unwrap_or(Value::Null);
        json!({
            "id": self.id,
            "seq": self.seq,
            "content": content,
            "localId": self.local_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }

    /// `{id, seq, localId, createdAt, updatedAt}` (v3 POST).
    pub fn send_json(&self) -> Value {
        json!({
            "id": self.id,
            "seq": self.seq,
            "localId": self.local_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }
}
