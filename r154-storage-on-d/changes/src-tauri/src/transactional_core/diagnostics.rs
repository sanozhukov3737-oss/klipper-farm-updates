use super::TransactionalCore;
use crate::{engine_client::EngineClient, now_ms, require_role, AuthState, Role, APP_VERSION};
use kf_ipc::EngineCommand;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const MAX_FRONTEND_LOG: usize = 2 * 1024 * 1024;
const MAX_RUNTIME_LOG: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticZipResult {
    path: String,
    size: u64,
    sha256: String,
}

#[tauri::command]
pub(crate) async fn diagnostic_zip_create(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    frontend_log: Option<String>,
) -> Result<DiagnosticZipResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Admin)?;
    let database_path = crate::db_path(&app)?;
    let use_daemon = client.route_to_daemon().await?;
    let engine_status = client.status_snapshot()?;
    let (snapshots, scheduler) = if use_daemon {
        let snapshots = client
            .call_async(
                super::engine_runtime::ExecutionClass::Control,
                EngineCommand::ActorList,
                Value::Null,
            )
            .await?;
        let scheduler = client
            .call_async(
                super::engine_runtime::ExecutionClass::Control,
                EngineCommand::SchedulerSnapshot,
                Value::Null,
            )
            .await?;
        (snapshots, scheduler)
    } else {
        core.initialize(&app)?;
        (core.snapshots(), core.scheduler_snapshot())
    };
    let output_root = crate::storage_paths::subdir(&app, "diagnostics")?;
    let filename = format!("klipper-farm-diagnostics-{}.zip", now_ms());
    let output = output_root.join(filename);
    let frontend_log = frontend_log
        .unwrap_or_default()
        .chars()
        .take(MAX_FRONTEND_LOG)
        .collect::<String>();
    let worker_output = output.clone();
    let result = super::engine_runtime::spawn_blocking(
        super::engine_runtime::ExecutionClass::FileIo,
        move || {
            create_diagnostic_zip(
                &worker_output,
                &database_path,
                snapshots,
                scheduler,
                engine_status,
                &frontend_log,
                database_path
                    .parent()
                    .map(|parent| parent.join("klipper-farmd.startup.log")),
                Some(crate::desktop_startup::startup_log_path()),
            )
        },
    )
    .await
    .map_err(|error| format!("Diagnostic ZIP worker failed: {error}"))??;
    crate::insert_audit(
        &app,
        &user.id,
        "diagnostics.export",
        "Создан диагностический ZIP без секретов",
    )?;
    Ok(result)
}

fn create_diagnostic_zip(
    output: &Path,
    database_path: &Path,
    snapshots: Vec<super::types::ActorSnapshot>,
    scheduler: super::types::SchedulerSnapshot,
    engine_status: crate::engine_client::EngineStatusSnapshot,
    frontend_log: &str,
    daemon_log_path: Option<PathBuf>,
    desktop_log_path: Option<PathBuf>,
) -> Result<DiagnosticZipResult, String> {
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    let migration_version = super::migrations::current_version(&connection).unwrap_or(0);
    let journal = read_journal(&connection)?;
    let uploads = read_uploads(&connection)?;
    let replay = read_replay(&connection)?;
    let diagnostic = serde_json::json!({
        "format":"klipper-farm-diagnostics-v13",
        "createdAt":now_ms(),
        "appVersion":APP_VERSION,
        "buildId":include_str!("../../../RELEASE-BUILD-ID.txt").trim(),
        "database":{"userVersion":schema_version,"migrationVersion":migration_version},
        "scheduler":scheduler,
        "actors":snapshots,
        "engine":engine_status,
        "platform":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH},
    });
    let mut diagnostic = diagnostic;
    redact_value(&mut diagnostic);
    let mut journal = Value::Array(journal);
    redact_value(&mut journal);
    let mut uploads = Value::Array(uploads);
    redact_value(&mut uploads);
    let mut replay = Value::Array(replay);
    redact_value(&mut replay);
    let frontend = redact_text(frontend_log);
    let readme = format!(
        "Klipper Farm diagnostic package\nVersion: {APP_VERSION}\nCreated: {}\n\nPasswords, API keys, authorization headers and tokens are removed automatically.\nThe package contains engine/actor state, bounded command states, upload metadata and bounded redacted startup/frontend diagnostics.\n",
        now_ms()
    );
    let mut entries = vec![
        (
            "diagnostics.json".to_string(),
            serde_json::to_vec_pretty(&diagnostic).map_err(|error| error.to_string())?,
        ),
        (
            "command-journal.json".to_string(),
            serde_json::to_vec_pretty(&journal).map_err(|error| error.to_string())?,
        ),
        (
            "transactional-uploads.json".to_string(),
            serde_json::to_vec_pretty(&uploads).map_err(|error| error.to_string())?,
        ),
        (
            "replay-frames.json".to_string(),
            serde_json::to_vec_pretty(&replay).map_err(|error| error.to_string())?,
        ),
        ("frontend.log".to_string(), frontend.into_bytes()),
        ("README.txt".to_string(), readme.into_bytes()),
    ];
    if let Some(log) = daemon_log_path
        .as_deref()
        .and_then(|path| read_redacted_runtime_log(path).ok())
    {
        entries.push(("klipper-farmd.startup.log".to_string(), log));
    }
    if let Some(log) = desktop_log_path
        .as_deref()
        .and_then(|path| read_redacted_runtime_log(path).ok())
    {
        entries.push(("desktop-startup.log".to_string(), log));
    }
    let temporary = output.with_extension("zip.tmp");
    write_zip_store(&temporary, &entries)?;
    crate::set_private_file_permissions(&temporary)?;
    fs::rename(&temporary, output).map_err(|error| error.to_string())?;
    let data = fs::read(output).map_err(|error| error.to_string())?;
    Ok(DiagnosticZipResult {
        path: output.to_string_lossy().to_string(),
        size: data.len() as u64,
        sha256: hex::encode(Sha256::digest(&data)),
    })
}

fn read_redacted_runtime_log(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Диагностический log не является обычным файлом".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let offset = metadata.len().saturating_sub(MAX_RUNTIME_LOG);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_RUNTIME_LOG) as usize);
    file.take(MAX_RUNTIME_LOG)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(redact_text(&String::from_utf8_lossy(&bytes)).into_bytes())
}

fn read_journal(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id,stable_id,session_epoch,method,params_json,repeat_policy,
                    priority,state,attempt_count,created_at,updated_at,result_json,last_error
             FROM command_journal ORDER BY updated_at DESC LIMIT 1000",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let params_json: Option<String> = row.get(4)?;
            let result_json: Option<String> = row.get(11)?;
            Ok(serde_json::json!({
                "operationId":row.get::<_,String>(0)?,
                "stableId":row.get::<_,String>(1)?,
                "sessionEpoch":row.get::<_,i64>(2)?,
                "method":row.get::<_,String>(3)?,
                "params":params_json.and_then(|value|serde_json::from_str::<Value>(&value).ok()),
                "repeatPolicy":row.get::<_,String>(5)?,
                "priority":row.get::<_,String>(6)?,
                "state":row.get::<_,String>(7)?,
                "attemptCount":row.get::<_,i64>(8)?,
                "createdAt":row.get::<_,i64>(9)?,
                "updatedAt":row.get::<_,i64>(10)?,
                "result":result_json.and_then(|value|serde_json::from_str::<Value>(&value).ok()),
                "lastError":row.get::<_,Option<String>>(12)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn read_uploads(connection: &Connection) -> Result<Vec<Value>, String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='transactional_uploads')",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT upload_id,stable_id,printer_id,filename,expected_size,received_size,
                    expected_sha256,state,result_path,created_at,updated_at,last_error
             FROM transactional_uploads ORDER BY updated_at DESC LIMIT 256",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "uploadId":row.get::<_,String>(0)?,
                "stableId":row.get::<_,String>(1)?,
                "printerId":row.get::<_,String>(2)?,
                "filename":row.get::<_,String>(3)?,
                "expectedSize":row.get::<_,i64>(4)?,
                "receivedSize":row.get::<_,i64>(5)?,
                "expectedSha256":row.get::<_,String>(6)?,
                "state":row.get::<_,String>(7)?,
                "resultPath":row.get::<_,Option<String>>(8)?,
                "createdAt":row.get::<_,i64>(9)?,
                "updatedAt":row.get::<_,i64>(10)?,
                "lastError":row.get::<_,Option<String>>(11)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn read_replay(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT trace_id,stable_id,direction,sequence_no,recorded_at,delay_ms,frame_json
             FROM replay_frames ORDER BY id DESC LIMIT 5000",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let frame_json: String = row.get(6)?;
            Ok(serde_json::json!({
                "traceId":row.get::<_,String>(0)?,
                "stableId":row.get::<_,String>(1)?,
                "direction":row.get::<_,String>(2)?,
                "sequenceNo":row.get::<_,i64>(3)?,
                "recordedAt":row.get::<_,i64>(4)?,
                "delayMs":row.get::<_,i64>(5)?,
                "frame":serde_json::from_str::<Value>(&frame_json).unwrap_or(Value::Null),
            }))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn redact_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object.iter_mut() {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "password",
                    "passwordhash",
                    "pin",
                    "pinhash",
                    "apikey",
                    "authorization",
                    "token",
                    "secret",
                    "sessiontoken",
                ]
                .iter()
                .any(|sensitive| normalized.contains(sensitive))
                {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        Value::String(text) => *text = redact_text(text),
        _ => {}
    }
}

pub(super) fn redact_text(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "x-api-key",
                "authorization",
                "api_key",
                "apikey",
                "password=",
                "password:",
                "password\"",
                "sessiontoken",
                "access_token",
                "refresh_token",
                "token=",
                "secret=",
                "pin_hash",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
                || (lower.contains("://") && lower.contains('@'))
                || looks_like_telegram_token(line)
            {
                "[REDACTED]".to_string()
            } else {
                line.chars().take(4096).collect()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn looks_like_telegram_token(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        let (left, right) = part.split_once(':').unwrap_or(("", ""));
        left.len() >= 6
            && left.bytes().all(|byte| byte.is_ascii_digit())
            && right.len() >= 20
            && right
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

struct CentralEntry {
    name: Vec<u8>,
    crc32: u32,
    size: u32,
    offset: u32,
}

fn write_zip_store(path: &Path, entries: &[(String, Vec<u8>)]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let mut central = Vec::new();
    for (name, data) in entries {
        let name = name.as_bytes().to_vec();
        if name.len() > u16::MAX as usize || data.len() > u32::MAX as usize {
            return Err("Diagnostic ZIP entry слишком велик".into());
        }
        let offset = file.stream_position().map_err(|error| error.to_string())? as u32;
        let crc32 = crc32(data);
        write_u32(&mut file, 0x0403_4b50)?;
        write_u16(&mut file, 20)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, crc32)?;
        write_u32(&mut file, data.len() as u32)?;
        write_u32(&mut file, data.len() as u32)?;
        write_u16(&mut file, name.len() as u16)?;
        write_u16(&mut file, 0)?;
        file.write_all(&name).map_err(|error| error.to_string())?;
        file.write_all(data).map_err(|error| error.to_string())?;
        central.push(CentralEntry {
            name,
            crc32,
            size: data.len() as u32,
            offset,
        });
    }
    let central_offset = file.stream_position().map_err(|error| error.to_string())? as u32;
    for entry in &central {
        write_u32(&mut file, 0x0201_4b50)?;
        write_u16(&mut file, 20)?;
        write_u16(&mut file, 20)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, entry.crc32)?;
        write_u32(&mut file, entry.size)?;
        write_u32(&mut file, entry.size)?;
        write_u16(&mut file, entry.name.len() as u16)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, 0)?;
        write_u32(&mut file, entry.offset)?;
        file.write_all(&entry.name)
            .map_err(|error| error.to_string())?;
    }
    let central_end = file.stream_position().map_err(|error| error.to_string())? as u32;
    write_u32(&mut file, 0x0605_4b50)?;
    write_u16(&mut file, 0)?;
    write_u16(&mut file, 0)?;
    write_u16(&mut file, central.len() as u16)?;
    write_u16(&mut file, central.len() as u16)?;
    write_u32(&mut file, central_end - central_offset)?;
    write_u32(&mut file, central_offset)?;
    write_u16(&mut file, 0)?;
    file.flush().map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_u16(writer: &mut impl Write, value: u16) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| error.to_string())
}

fn write_u32(writer: &mut impl Write, value: u32) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| error.to_string())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_removes_structured_and_text_secrets() {
        let mut value = serde_json::json!({
            "apiKey":"secret",
            "nested":{"passwordHash":"hash","safe":"value"}
        });
        redact_value(&mut value);
        assert_eq!(value["apiKey"], "[REDACTED]");
        assert_eq!(value["nested"]["passwordHash"], "[REDACTED]");
        assert_eq!(value["nested"]["safe"], "value");
        assert_eq!(redact_text("X-Api-Key: abc"), "[REDACTED]");
        assert_eq!(
            redact_text("connect http://user:password@192.168.1.2"),
            "[REDACTED]"
        );
        assert_eq!(redact_text("url?access_token=abc"), "[REDACTED]");
    }

    #[test]
    fn crc32_matches_standard_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
}
