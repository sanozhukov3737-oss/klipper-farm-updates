//! Команды базы данных, аудита и уведомлений.
//!
//! Всё, что читает и пишет хранилище ключ-значение, ведёт журнал аудита и
//! отдаёт ленту уведомлений. Политика ролей остаётся здесь, потому что она
//! неотделима от того, какие ключи разрешено трогать.

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, State};

use crate::audit_chain;
use crate::filament_inventory;
use crate::{
    now_ms, open_db, parse_role, require_role, users_list_internal, validate_key, AppUser,
    AuditEntry, AuthState, Role, APP_VERSION, validate_user_id,
};

pub(crate) fn insert_audit(app: &AppHandle, user: &str, action: &str, details: &str) -> Result<(), String> {
    if action.is_empty() || action.len() > 96 || details.len() > 4096 {
        return Err("Событие аудита превышает допустимый размер".into());
    }
    let mut conn = open_db(app)?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let timestamp = now_ms();
    audit_chain::insert(&transaction, timestamp, user, action, details)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn db_write_role(key: &str) -> Result<Role, String> {
    if key == filament_inventory::INVENTORY_KEY {
        return Err("Учёт пластика сохраняется только атомарной командой filament_inventory_commit".into());
    }
    if matches!(
        key,
        "printers.config"
            | "notifications.telegram"
            | "release.updateEndpoint"
            | "release.updatePubkey"
    ) {
        return Ok(Role::Admin);
    }
    if key.starts_with("production.")
        || key.starts_with("dispatch.")
        || key.starts_with("maintenance.")
    {
        return Ok(Role::Operator);
    }
    Err("Запись этого ключа запрещена политикой безопасности".into())
}

#[tauri::command]
pub(crate) fn db_get_json(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    key: String,
) -> Result<Option<String>, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    validate_key(&key)?;
    let conn = open_db(&app)?;
    match conn.query_row("SELECT value FROM kv WHERE key=?1", params![key], |row| {
        row.get(0)
    }) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn db_list_keys(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    prefix: String,
) -> Result<Vec<String>, String> {
    // Only a prefixed listing: callers pick a namespace, they never enumerate
    // the whole store, so secrets under other prefixes stay out of reach.
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    if prefix.is_empty() {
        return Err("Нужен непустой префикс ключей".into());
    }
    validate_key(&format!("{prefix}#"))?;
    let conn = open_db(&app)?;
    let mut statement = conn
        .prepare("SELECT key FROM kv WHERE key LIKE ?1 ORDER BY key")
        .map_err(|e| e.to_string())?;
    let mut escaped = String::with_capacity(prefix.len());
    for value in prefix.chars() {
        if matches!(value, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(value);
    }
    let rows = statement
        .query_map([format!("{escaped}%")], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut keys = Vec::new();
    for row in rows {
        keys.push(row.map_err(|e| e.to_string())?);
    }
    Ok(keys)
}

#[tauri::command]
pub(crate) fn db_delete_json(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    key: String,
) -> Result<(), String> {
    validate_key(&key)?;
    require_role(&app, &auth, &session_token, db_write_role(&key)?)?;
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM kv WHERE key=?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_set_json(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    key: String,
    value: String,
) -> Result<(), String> {
    validate_key(&key)?;
    require_role(&app, &auth, &session_token, db_write_role(&key)?)?;
    if value.len() > 2 * 1024 * 1024 || serde_json::from_str::<serde_json::Value>(&value).is_err() {
        return Err("Недопустимое JSON-значение".into());
    }
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO kv(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![key, value, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn audit_add(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    action: String,
    details: String,
) -> Result<(), String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    if parse_role(&user.role)? < Role::Operator && !notification_action_allowed(&action) {
        return Err(
            "FORBIDDEN: наблюдатель может записывать только безопасные события уведомлений".into(),
        );
    }
    insert_audit(&app, &user.id, &action, &details)
}

pub(crate) fn notification_action_allowed(action: &str) -> bool {
    matches!(
        action,
        "print.complete"
            | "print.cancelled"
            | "printer.error"
            | "printer.offline"
            | "printer.online"
            | "filament.runout"
            | "print.dispatch"
            | "print.validated_start"
            | "print.queue_add"
            | "queue.auto_start"
            | "queue.manual_start"
            | "queue.auto_blocked"
            | "queue.start_blocked"
            | "gcode.blocked"
            | "schedule.blocked"
            | "maintenance.complete"
            | "maintenance.due"
            | "camera.warning"
            | "camera.paused"
            | "camera.pause_failed"
            | "diagnostics.complete"
            | "history.snapshot_saved"
            | "notification.test"
            | "update.available"
            | "update.current"
            | "update.error"
    )
}

#[tauri::command]
pub(crate) fn audit_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    limit: i64,
) -> Result<Vec<AuditEntry>, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let conn = open_db(&app)?;
    let mut statement = conn
        .prepare("SELECT id,ts,user,action,details FROM audit ORDER BY id DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![limit.clamp(1, 2000)], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                ts: row.get(1)?,
                user: row.get(2)?,
                action: row.get(3)?,
                details: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn notification_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    limit: i64,
) -> Result<Vec<AuditEntry>, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let conn = open_db(&app)?;
    let mut statement = conn
        .prepare(
            "SELECT id,ts,user,action,details FROM audit
             WHERE action IN (
               'print.complete','print.cancelled','printer.error','printer.offline','printer.online','filament.runout','filament.milestone','filament.reserve',
               'print.dispatch','print.validated_start','print.queue_add','queue.auto_start','queue.manual_start',
               'queue.auto_blocked','queue.start_blocked','gcode.blocked','schedule.blocked',
               'maintenance.complete','maintenance.due','camera.warning','camera.paused','camera.pause_failed','diagnostics.complete','history.snapshot_saved',
               'notification.test','update.available','update.current','update.error'
             )
             ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![limit.clamp(1, 500)], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                ts: row.get(1)?,
                user: row.get(2)?,
                action: row.get(3)?,
                details: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_backup_json(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
) -> Result<String, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let conn = open_db(&app)?;
    let mut kv = serde_json::Map::new();
    let mut statement = conn
        .prepare("SELECT key,value FROM kv")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        kv.insert(
            key,
            serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value)),
        );
    }
    let users = users_list_internal(&conn)?;
    let mut audit_statement = conn
        .prepare("SELECT id,ts,user,action,details FROM audit ORDER BY id DESC LIMIT 2000")
        .map_err(|e| e.to_string())?;
    let audit = audit_statement
        .query_map([], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                ts: row.get(1)?,
                user: row.get(2)?,
                action: row.get(3)?,
                details: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&serde_json::json!({
        "format": "klipper-farm-v18",
        "app_version": APP_VERSION,
        "created_at": now_ms(),
        "kv": kv,
        "users": users,
        "audit": audit
    }))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_restore_json(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    raw: String,
) -> Result<(), String> {
    let actor = require_role(&app, &auth, &session_token, Role::Admin)?;
    if raw.len() > 16 * 1024 * 1024 {
        return Err("Резервная копия слишком велика".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Неверный JSON: {e}"))?;
    if !matches!(
        value.get("format").and_then(|item| item.as_str()),
        Some("klipper-farm-v07")
            | Some("klipper-farm-v10")
            | Some("klipper-farm-v16")
            | Some("klipper-farm-v17")
            | Some("klipper-farm-v18")
    ) {
        return Err("Это не резервная копия Klipper Farm".into());
    }
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if let Some(kv) = value.get("kv").and_then(|item| item.as_object()) {
        if kv.len() > 2000 {
            return Err("Слишком много записей в резервной копии".into());
        }
        for (key, item) in kv {
            validate_key(key)?;
            let text = serde_json::to_string(item).map_err(|e| e.to_string())?;
            if text.len() > 2 * 1024 * 1024 {
                return Err("Запись резервной копии слишком велика".into());
            }
            tx.execute(
                "INSERT INTO kv(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![key, text, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(users) = value.get("users").and_then(|item| item.as_array()) {
        if users.len() > 200 {
            return Err("Слишком много пользователей в резервной копии".into());
        }
        for item in users {
            let Ok(restored) = serde_json::from_value::<AppUser>(item.clone()) else {
                continue;
            };
            let id = restored.id.trim().to_lowercase();
            if validate_user_id(&id).is_err() || parse_role(&restored.role).is_err() {
                continue;
            }
            let existing_hash: Option<String> = tx
                .query_row(
                    "SELECT password_hash FROM users WHERE id=?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            let is_admin = id == "admin";
            let role = if is_admin {
                "admin"
            } else {
                restored.role.as_str()
            };
            tx.execute(
                "INSERT INTO users(id,name,role,enabled,created_at,password_hash) VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,enabled=excluded.enabled",
                params![
                    id,
                    restored.name.chars().take(80).collect::<String>(),
                    role,
                    if is_admin || (restored.enabled && existing_hash.is_some()) { 1 } else { 0 },
                    restored.created_at.max(1),
                    existing_hash
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(entries) = value.get("audit").and_then(|item| item.as_array()) {
        for item in entries.iter().take(2000) {
            if let Ok(entry) = serde_json::from_value::<AuditEntry>(item.clone()) {
                if entry.action.len() <= 96 && entry.details.len() <= 4096 && entry.user.len() <= 64
                {
                    let exists: i64 = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM audit WHERE ts=?1 AND user=?2 AND action=?3 AND details=?4)",
                            params![entry.ts, entry.user, entry.action, entry.details],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    if exists == 0 {
                        audit_chain::insert(
                            &tx,
                            entry.ts,
                            &entry.user,
                            &entry.action,
                            &entry.details,
                        )?;
                    }
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    insert_audit(
        &app,
        &actor.id,
        "backup.restore",
        "Резервная копия восстановлена",
    )
}
