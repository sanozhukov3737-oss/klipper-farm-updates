#![allow(clippy::too_many_arguments)]


// Протокол вынесен в rpc.rs; имена остаются доступны как crate::имя,
// чтобы вызовы в остальных модулях не менялись.
// Пути локальной библиотеки вынесены; имена остаются доступны как crate::имя.
// Три функции ниже зависят от Tauri-состояния (AppHandle), поэтому остаются
// в корне: они не чистые преобразования путей, а доступ к каталогу данных.
fn local_library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = storage_paths::root(app)?;
    fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    let root = app_data.join("local-gcode-library");
    match fs::symlink_metadata(&root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&root).map_err(|e| e.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(&root).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Каталог локальной библиотеки подменён или повреждён".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(root)
}
fn local_library_printer_scope(printer_id: &str) -> Result<String, String> {
    validate_secret_id(printer_id)?;
    // The public printer id is validated, then hashed before it is used as a
    // Windows directory name. This keeps every printer in a stable, private
    // namespace without trusting user-controlled path segments.
    Ok(hex::encode(Sha256::digest(printer_id.as_bytes())))
}
fn local_library_printer_root(app: &AppHandle, printer_id: &str) -> Result<PathBuf, String> {
    let base = local_library_root(app)?;
    let root = base
        .join("by-printer")
        .join(local_library_printer_scope(printer_id)?);
    create_local_library_parent(&base, &root)?;
    Ok(root)
}

// Права доступа вынесены в permissions; имена остаются доступны как crate::имя,
// чтобы 15 вызовов в других модулях не менялись.
pub(crate) use permissions::{
    set_private_directory_permissions, set_private_file_permissions,
    windowless_windows_command,
};

pub(crate) use local_library_paths::{
    local_library_directory_path, local_library_file_path, normalize_local_library_directory,
    normalize_local_library_path, };

pub(crate) use rpc::{
    bounded_http_timeout, bounded_rpc_timeout, moonraker_rpc, moonraker_ws_rpc, rpc_async,
};
#[cfg(test)]
pub(crate) use rpc::{
    files_move_fallback, objects_query_get_fallback, parse_moonraker_result, queue_delete_fallback,
    rest_fallback_for_rpc, should_try_query_compatibility_fallback, should_try_rest_fallback,
};
#[cfg(test)]
pub(crate) use permissions::parse_windows_sid;

#[cfg(test)]
pub(crate) use rpc::{execute_rest_rpc_fallback, moonraker_query_result_useful, rpc_blocking, rpc_required_role};


use getrandom::getrandom;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

#[cfg(windows)]
#[cfg(windows)]

mod auth_policy;
mod auth_commands;
mod db_commands;
mod app;
mod discovery_merge;
/// Список команд для generate_handler!. Живёт в корне, потому что макрос
/// __cmd__* генерируется рядом с каждой командой, и все они должны быть в
/// области видимости одного места. Вынесение в app.rs потребовало бы
/// glob-импорта из каждого модуля и дало бы неоднозначность имён.
pub(crate) fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
            offline_semantic::voice_semantic_status,
            offline_semantic::voice_semantic_prepare,
            offline_semantic::voice_semantic_interpret,
            offline_semantic::voice_semantic_cancel,
            offline_voice::voice_tools_status,
            offline_voice::voice_prepare,
            offline_voice::voice_transcribe,
            offline_voice::voice_synthesize,
            auth_status,
            auth_bootstrap,
            auth_login,
            auth_pin_login,
            auth_hello_status,
            auth_hello_enable,
            auth_hello_disable,
            auth_hello_login,
            auth_logout,
            auth_change_password,
            discover_moonraker,
            probe_moonraker_host,
            validate_moonraker_api_key,
            validate_stored_moonraker_api_key,
            network_environment_snapshot,
            recheck_saved_printer_identity,
            cancel_moonraker_discovery,
            moonraker_rpc,
            moonraker_ws_rpc,
            creality_light,
            headless_engine_status,
            printer_actor_upsert,
            printer_actor_rpc,
            printer_actor_list,
            printer_actor_snapshots,
            printer_actor_cancel,
            printer_actor_remove,
            printer_actor_reattest,
            printer_actor_events_pending,
            printer_actor_events_ack,
            farm_scheduler_snapshot,
            farm_scheduler_set_printer_weight,
            transactional_core_runtime_snapshot,
            transactional_operations_list,
            transactional_operation_resolve,
            transactional_journal_housekeeping,
            moonraker_http,
            moonraker_upload,
            moonraker_upload_begin,
            moonraker_upload_chunk,
            moonraker_upload_finish,
            moonraker_upload_abort,
            transactional_upload_begin,
            transactional_upload_chunk,
            transactional_upload_finish,
            transactional_upload_abort,
            transactional_upload_list,
            local_library_commands::local_library_list,
            local_library_commands::local_library_adopt_legacy,
            local_library_commands::local_library_merge_scopes,
            local_library_commands::local_library_import,
            local_library_commands::local_library_import_begin,
            local_library_commands::local_library_import_chunk,
            local_library_commands::local_library_import_finish,
            local_library_commands::local_library_import_abort,
            local_library_commands::local_library_read_text,
            local_library_commands::local_library_read_begin,
            local_library_commands::local_library_read_chunk,
            local_library_commands::local_library_read_abort,
            local_library_commands::local_library_read_preview_text,
            local_library_commands::local_library_delete,
            local_library_commands::local_library_delete_directory,
            local_library_commands::local_library_upload_to_printer,
            moonraker_snapshot,
            snapshot_store,
            snapshot_read,
            creality_webrtc_offer,
            db_get_json,
            db_set_json,
            db_list_keys,
            db_delete_json,
            filament_inventory::filament_inventory_commit,
            audit_add,
            audit_list,
            notification_list,
            users_list,
            user_save,
            user_delete,
            db_backup_json,
            db_restore_json,
            secret_set,
            secret_delete,
            telegram_send,
            native_notify,
            autostart_get,
            autostart_set,
            desktop_background::background_mode_get,
            desktop_background::background_mode_set,
            update_status,
            update_cancel,
            update_apply,
            update_check,
            update_available,
            update_install,
            update_verify_offline,
            diagnostic_zip_create,
            storage_commands::storage_location,
            verification_replay_plan,
            profile_signer_set,
            profile_signer_rotate,
            profile_signer_revoke,
            signed_profile_install,
            farm_queue_enqueue_v2,
            farm_queue_dispatch_v2,
            farm_queue_transition_v3,
            farm_queue_events_v3,
            maintenance_observe
        ]
}
// Точка входа остаётся с прежним именем: main.rs её не меняет.
pub use app::run;
// Команды вынесены в auth_commands; имена остаются доступны как crate::имя,
// чтобы invoke_handler и остальной код не менялись.
pub(crate) use auth_commands::{
    auth_bootstrap, auth_change_password, auth_hello_disable, auth_hello_enable, auth_hello_login,
    auth_hello_status, auth_login, auth_logout, auth_pin_login, auth_status, user_delete, user_save,
    users_list,
};
// Эти нужны и корню, и auth_policy, и тестам: реэкспорт без cfg.
pub(crate) use auth_commands::{
    user_by_id, users_list_internal, validate_user_id,
};
// dedupe и ранжирование нужны снаружи; остальные — только внутри модуля
// и тестам, поэтому под cfg(test).
pub(crate) use discovery_merge::dedupe_discovered_printers;
#[cfg(test)]
pub(crate) use discovery_merge::{
    discovery_identity, discovery_identity_conflicts, discovery_identity_labels,
    discovery_identity_match, discovery_result_rank, discovery_source_rank,
    mark_discovery_conflict, same_discovered_printer,
};
pub(crate) use db_commands::{
    audit_add, audit_list, db_backup_json, db_delete_json, db_get_json, db_list_keys,
    db_restore_json, db_set_json, insert_audit,
    notification_list,
};
#[cfg(test)]
pub(crate) use db_commands::{db_write_role, notification_action_allowed};

#[cfg(test)]
pub(crate) use auth_commands::{
    auth_credentials_configured, auth_login_internal, ensure_pin_removal_keeps_access,
    hash_password, hash_pin, hello_grant_matches, new_session, revoke_user_sessions, verify_password,
    verify_pin,
};
mod permissions;
mod local_library_paths;
mod rpc;
mod creality_light;
mod windows_hello;
mod audit_chain;
mod core_error;
mod database;
mod desktop_startup;
mod desktop_background;
mod discovery_commands;
#[cfg(windows)]
mod desktop_job;
mod engine_client;
mod filament_inventory;
mod local_library_commands;
mod offline_voice;
mod offline_semantic;
pub mod headless_engine;
mod moonraker_protocol;
mod observability;
mod online_updates;
mod update_cache;
mod system_commands;
mod transactional_core;
mod storage_paths;
mod storage_commands;

pub(crate) use database::{db_path, open_db};
use online_updates::{update_apply, update_available, update_cancel, update_check, update_install, update_status};
use discovery_commands::{
    cancel_moonraker_discovery, discover_moonraker, probe_moonraker_host,
    network_environment_snapshot, recheck_saved_printer_identity, validate_moonraker_api_key,
    validate_stored_moonraker_api_key,
};
#[cfg(test)]
use discovery_commands::{
    discovered_printer_from_payload, discovery_diagnostic, discovery_network,
    discovery_network_addresses, discovery_operation_id, discovery_retryable_error,
    discovery_subnets,
    parse_manual_discovery_range, probe_with_timeout, scan_discovery_targets, DiscoveryProbe,
    DiscoveryProbeOutcome,
};
pub(crate) use moonraker_protocol::*;

use system_commands::{
    autostart_get, autostart_set, creality_webrtc_offer, moonraker_snapshot, native_notify,
    secret_delete, secret_set, snapshot_read, snapshot_store, telegram_send, update_verify_offline,
};
use transactional_core::engine_runtime::{
    spawn_blocking as bounded_spawn_blocking, ExecutionClass,
};
use transactional_core::{
    diagnostic_zip_create, farm_queue_dispatch_v2, farm_queue_enqueue_v2, farm_queue_events_v3,
    farm_queue_transition_v3, farm_scheduler_set_printer_weight, farm_scheduler_snapshot,
    maintenance_observe, printer_actor_cancel, printer_actor_events_ack,
    printer_actor_events_pending, printer_actor_list, printer_actor_reattest, printer_actor_remove,
    printer_actor_rpc, printer_actor_snapshots, printer_actor_upsert, profile_signer_revoke,
    profile_signer_rotate, profile_signer_set, signed_profile_install,
    transactional_core_runtime_snapshot, transactional_journal_housekeeping,
    transactional_operation_resolve, transactional_operations_list, transactional_upload_abort,
    transactional_upload_begin, transactional_upload_chunk, transactional_upload_finish,
    transactional_upload_list, verification_replay_plan, TransactionalCore,
    TransactionalUploadState,
};

const APP_VERSION: &str = "1.14.5";
const SECRET_SERVICE: &str = "app.klipper.farm.moonraker";
const TELEGRAM_TOKEN_ID: &str = "__klipper_farm_telegram_bot_token__";
const PASSWORD_ITERATIONS: u32 = 310_000;
const PIN_ITERATIONS: u32 = 310_000;
const SESSION_IDLE_MS: i64 = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS: i64 = 24 * 60 * 60 * 1000;
const FAILURE_RECORD_TTL_MS: i64 = 30 * 60 * 1000;
#[allow(dead_code)] // используется модулем auth_policy
const MAX_FAILURE_RECORDS: usize = 1_024;
const GLOBAL_FAILURE_LIMIT: u8 = 50;
const MAX_JSON_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_FILE_RESPONSE: usize = 32 * 1024 * 1024;
const MAX_UPLOAD: usize = 100 * 1024 * 1024;
const MAX_UPLOAD_CHUNK: usize = 512 * 1024;
const UPLOAD_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_TRANSFER_SESSIONS: usize = 8;
const MAX_LOCAL_PREVIEW: usize = 8 * 1024 * 1024;
const MAX_LOCAL_LIBRARY_FILES: usize = 5_000;
const MAX_LOCAL_LIBRARY_PATH: usize = 2_048;
const MAX_DISCOVERY_SUBNETS: usize = 12;
const MAX_DISCOVERY_ADDRESSES: usize = 3_072;
const DISCOVERY_FAST_WORKERS: usize = 64;
const DISCOVERY_SLOW_WORKERS: usize = 64;
const DISCOVERY_DEADLINE: Duration = Duration::from_secs(9);
const DISCOVERY_FAST_PROBE_TIMEOUT: Duration = Duration::from_millis(240);
const DISCOVERY_SLOW_PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const DISCOVERY_MANUAL_PROBE_TIMEOUT: Duration = Duration::from_millis(1_200);
const DISCOVERY_PROGRESS_EVENT: &str = "moonraker-discovery-progress";
const DISCOVERY_FOUND_EVENT: &str = "moonraker-discovery-result";
const MAX_DISCOVERY_DIAGNOSTIC_ENTRIES: usize = 192;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
struct DiscoveredPrinter {
    host: String,
    ip: String,
    port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    moonraker_uuid: Option<String>,
    klippy_state: Option<String>,
    moonraker_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stable_id: Option<String>,
    auth_required: bool,
    moonraker_confirmed: bool,
    probe_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    working_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    working_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity_conflict: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    conflict_hosts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    conflict_identities: Vec<String>,
}










#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct DiscoveryTarget {
    ip: Ipv4Addr,
    port: u16,
    bind_ip: Option<Ipv4Addr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DiscoveryNetwork {
    network: Ipv4Addr,
    prefix: u8,
}

#[derive(Debug, Clone, Serialize)]
struct DiscoveryResult {
    operation_id: String,
    printers: Vec<DiscoveredPrinter>,
    scanned_subnets: Vec<String>,
    scanned: usize,
    total: usize,
    cancelled: bool,
    timed_out: bool,
    duration_ms: u64,
    retried: usize,
    manual_range: Option<String>,
    diagnostics: DiscoveryDiagnostics,
    fast_recovery: bool,
}

#[derive(Debug, Clone, Serialize)]
struct DiscoveryProgress {
    operation_id: String,
    phase: String,
    scanned: usize,
    total: usize,
    found: usize,
}

#[derive(Debug, Clone, Serialize)]
struct DiscoveryFound {
    operation_id: String,
    printer: DiscoveredPrinter,
}

#[derive(Debug, Clone, Serialize)]
struct DiscoveryDiagnosticEntry {
    host: String,
    outcome: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct DiscoveryDiagnostics {
    counts: HashMap<String, usize>,
    entries: Vec<DiscoveryDiagnosticEntry>,
    adapters: Vec<transactional_core::discovery::PhysicalDiscoveryAdapter>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkEnvironmentSnapshot {
    fingerprint: String,
    observed_at: i64,
    adapters: Vec<transactional_core::discovery::PhysicalDiscoveryAdapter>,
}

#[derive(Debug, Default)]
struct DiscoveryDiagnosticAccumulator {
    counts: HashMap<String, usize>,
    entries: Vec<DiscoveryDiagnosticEntry>,
}

impl DiscoveryDiagnosticAccumulator {
    fn record(&mut self, entry: DiscoveryDiagnosticEntry) {
        let count = self.counts.entry(entry.outcome.clone()).or_default();
        *count = (*count).saturating_add(1);
        let sample_limit = match entry.outcome.as_str() {
            "closed_port" => 12,
            "timeout" | "network_error" => 24,
            _ => MAX_DISCOVERY_DIAGNOSTIC_ENTRIES,
        };
        if *count <= sample_limit && self.entries.len() < MAX_DISCOVERY_DIAGNOSTIC_ENTRIES {
            self.entries.push(entry);
        }
    }

    fn merge(&mut self, diagnostics: DiscoveryDiagnostics) {
        for (key, count) in diagnostics.counts {
            let current = self.counts.entry(key).or_default();
            *current = (*current).saturating_add(count);
        }
        for entry in diagnostics.entries {
            if self.entries.len() >= MAX_DISCOVERY_DIAGNOSTIC_ENTRIES {
                break;
            }
            self.entries.push(entry);
        }
    }

    fn finish(
        self,
        adapters: Vec<transactional_core::discovery::PhysicalDiscoveryAdapter>,
    ) -> DiscoveryDiagnostics {
        DiscoveryDiagnostics {
            counts: self.counts,
            entries: self.entries,
            adapters,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuditEntry {
    id: i64,
    ts: i64,
    user: String,
    action: String,
    details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppUser {
    id: String,
    name: String,
    role: String,
    enabled: bool,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "pinEnabled", default)]
    pin_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct UserInput {
    id: String,
    name: String,
    role: String,
    enabled: bool,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    pin: Option<String>,
    #[serde(rename = "clearPin", default)]
    clear_pin: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthStatus {
    needs_setup: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthSession {
    token: String,
    user: AppUser,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionRecord {
    user_id: String,
    created_at: i64,
    last_seen: i64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct FailureRecord {
    count: u8,
    locked_until: i64,
    last_seen: i64,
}

#[derive(Default)]
pub(crate) struct AuthInner {
    sessions: HashMap<String, SessionRecord>,
    failures: HashMap<String, FailureRecord>,
    global_failures: FailureRecord,
}

#[derive(Default)]
struct AuthState {
    inner: Mutex<AuthInner>,
    hello_busy: Arc<AtomicBool>,
}

#[derive(Default)]
struct DiscoveryState {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // At most one scan core runs and one replacement may wait after the user
    // cancels the active operation and immediately starts another one.
    run_gate: Arc<Mutex<()>>,
}

#[derive(Clone, Default)]
struct UploadState {
    sessions: Arc<Mutex<HashMap<String, UploadSession>>>,
}

struct UploadSession {
    stream: TcpStream,
    suffix: Vec<u8>,
    expected_size: u64,
    received_size: u64,
    filename: String,
    printer_id: String,
    owner_id: String,
    started: Instant,
    hasher: Sha256,
}

#[derive(Clone, Default)]
struct LocalTransferState {
    imports: Arc<Mutex<HashMap<String, LocalImportSession>>>,
    reads: Arc<Mutex<HashMap<String, LocalReadSession>>>,
}

struct LocalImportSession {
    file: fs::File,
    temporary: PathBuf,
    destination: PathBuf,
    root: PathBuf,
    relative: String,
    expected_size: u64,
    received_size: u64,
    overwrite: bool,
    printer_id: String,
    owner_id: String,
    started: Instant,
}

struct LocalReadSession {
    file: fs::File,
    expected_size: u64,
    received_size: u64,
    owner_id: String,
    started: Instant,
    hasher: Sha256,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadBeginResult {
    upload_id: String,
    chunk_size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadFinishResult {
    path: String,
    sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportBeginResult {
    import_id: Option<String>,
    chunk_size: usize,
    result: Option<LocalLibraryImportResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalReadBeginResult {
    read_id: String,
    size: u64,
    chunk_size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalReadChunkResult {
    data: Vec<u8>,
    next_offset: u64,
    done: bool,
    sha256: Option<String>,
}

impl DiscoveryState {
    fn begin(&self, operation_id: &str) -> Result<(Arc<AtomicBool>, Arc<Mutex<()>>), String> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "Состояние поиска Moonraker недоступно")?;
        if operations.contains_key(operation_id)
            || operations.len() >= 2
            || operations
                .values()
                .any(|flag| !flag.load(Ordering::Acquire))
        {
            return Err("DISCOVERY_BUSY: поиск Moonraker уже выполняется".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        operations.insert(operation_id.to_string(), Arc::clone(&cancelled));
        Ok((cancelled, Arc::clone(&self.run_gate)))
    }

    fn cancel(&self, operation_id: &str) -> Result<bool, String> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| "Состояние поиска Moonraker недоступно")?;
        let Some(flag) = operations.get(operation_id) else {
            return Ok(false);
        };
        flag.store(true, Ordering::Release);
        Ok(true)
    }

    fn finish(&self, operation_id: &str, flag: &Arc<AtomicBool>) -> Result<(), String> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "Состояние поиска Moonraker недоступно")?;
        if operations
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, flag))
        {
            operations.remove(operation_id);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Role {
    Viewer,
    Operator,
    Admin,
}

#[derive(Debug)]
struct HttpTarget {
    authority: String,
    socket: SocketAddr,
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHttpResponse {
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryEntry {
    path: String,
    size: u64,
    modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryListResult {
    files: Vec<LocalLibraryEntry>,
    legacy_files: usize,
    legacy_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryAdoptResult {
    moved: usize,
    skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryMergeResult {
    moved: usize,
    renamed: usize,
    duplicates: usize,
    conflicts: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryImportResult {
    path: String,
    size: u64,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryDirectoryDeleteResult {
    path: String,
    files: usize,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryText {
    text: String,
    sha256: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
















fn create_local_library_parent(root: &Path, parent: &Path) -> Result<(), String> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "Недопустимый каталог локальной библиотеки")?;
    let mut current = root.to_path_buf();
    set_private_directory_permissions(&current)?;
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("Недопустимый каталог локальной библиотеки".into());
        };
        current.push(segment);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|e| e.to_string())?;
                fs::symlink_metadata(&current).map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Каталог локальной библиотеки подменён или повреждён".into());
        }
        set_private_directory_permissions(&current)?;
    }
    Ok(())
}

fn validate_local_library_parent(root: &Path, parent: &Path) -> Result<(), String> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "Недопустимый каталог локальной библиотеки")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("Недопустимый каталог локальной библиотеки".into());
        };
        current.push(segment);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "Папка локальной библиотеки не найдена")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Каталог локальной библиотеки подменён или повреждён".into());
        }
    }
    Ok(())
}

fn list_local_library_files(root: &Path) -> Result<Vec<LocalLibraryEntry>, String> {
    let mut output = Vec::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if directories.len() + output.len() >= MAX_LOCAL_LIBRARY_FILES {
                    return Err("Локальная библиотека содержит слишком много элементов".into());
                }
                directories.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Повреждён путь локальной библиотеки")?
                .to_string_lossy()
                .replace('\\', "/");
            if normalize_local_library_path(&relative).is_err() {
                continue;
            }
            output.push(LocalLibraryEntry {
                path: relative,
                size: metadata.len(),
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis() as i64),
            });
            if output.len() >= MAX_LOCAL_LIBRARY_FILES {
                return Err("Локальная библиотека содержит более 5000 G-code файлов".into());
            }
        }
    }
    output.sort_by_key(|entry| entry.path.to_lowercase());
    Ok(output)
}

fn list_legacy_local_library_files(root: &Path) -> Result<Vec<LocalLibraryEntry>, String> {
    let mut output = Vec::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            let is_scoped_root = directory.as_path() == root
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("by-printer");
            if metadata.file_type().is_symlink() || is_scoped_root {
                continue;
            }
            if metadata.is_dir() {
                if directories.len() + output.len() >= MAX_LOCAL_LIBRARY_FILES {
                    return Err("Старая общая библиотека содержит слишком много элементов".into());
                }
                directories.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Повреждён путь старой локальной библиотеки")?
                .to_string_lossy()
                .replace('\\', "/");
            if normalize_local_library_path(&relative).is_err() {
                continue;
            }
            output.push(LocalLibraryEntry {
                path: relative,
                size: metadata.len(),
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis() as i64),
            });
            if output.len() >= MAX_LOCAL_LIBRARY_FILES {
                return Err("Старая общая библиотека содержит более 5000 G-code файлов".into());
            }
        }
    }
    output.sort_by_key(|entry| entry.path.to_lowercase());
    Ok(output)
}

fn read_local_library_file(
    root: &Path,
    value: &str,
    maximum: usize,
) -> Result<(String, Vec<u8>), String> {
    let (relative, path) = local_library_file_path(root, value)?;
    validate_local_library_parent(
        root,
        path.parent().ok_or("Не удалось определить папку G-code")?,
    )?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Файл не найден в локальной библиотеке")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Объект локальной библиотеки не является обычным файлом".into());
    }
    if metadata.len() == 0 || metadata.len() > maximum as u64 {
        return Err(format!(
            "G-code пуст или превышает лимит {} MiB",
            maximum / 1024 / 1024
        ));
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    if data.len() > maximum {
        return Err("Размер G-code изменился во время чтения".into());
    }
    Ok((relative, data))
}

fn read_local_library_prefix(root: &Path, value: &str, maximum: usize) -> Result<Vec<u8>, String> {
    let (_, path) = local_library_file_path(root, value)?;
    validate_local_library_parent(
        root,
        path.parent().ok_or("Не удалось определить папку G-code")?,
    )?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Файл не найден в локальной библиотеке")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Объект локальной библиотеки не является обычным файлом".into());
    }
    if metadata.len() == 0 {
        return Err("G-code пуст".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let capacity = usize::try_from(metadata.len().min(maximum as u64)).unwrap_or(maximum);
    let mut data = Vec::with_capacity(capacity);
    let mut limited = file.take(maximum as u64);
    limited.read_to_end(&mut data).map_err(|e| e.to_string())?;
    Ok(data)
}

fn local_library_files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::symlink_metadata(left).map_err(|e| e.to_string())?;
    let right_metadata = fs::symlink_metadata(right).map_err(|e| e.to_string())?;
    if left_metadata.file_type().is_symlink()
        || right_metadata.file_type().is_symlink()
        || !left_metadata.is_file()
        || !right_metadata.is_file()
    {
        return Err("Сравнивать можно только обычные G-code файлы".into());
    }
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    let mut left_file = fs::File::open(left).map_err(|e| e.to_string())?;
    let mut right_file = fs::File::open(right).map_err(|e| e.to_string())?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left_file
            .read(&mut left_buffer)
            .map_err(|e| e.to_string())?;
        let right_read = right_file
            .read(&mut right_buffer)
            .map_err(|e| e.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn prune_empty_local_library_parents(root: &Path, start: Option<&Path>) -> Result<(), String> {
    let mut current = start;
    while let Some(directory) = current {
        if directory == root {
            break;
        }
        validate_local_library_parent(root, directory)?;
        if fs::read_dir(directory)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            break;
        }
        let parent = directory.parent();
        fs::remove_dir(directory).map_err(|e| e.to_string())?;
        current = parent;
    }
    Ok(())
}

fn parse_role(value: &str) -> Result<Role, String> {
    match value {
        "admin" => Ok(Role::Admin),
        "operator" => Ok(Role::Operator),
        "viewer" => Ok(Role::Viewer),
        _ => Err("Недопустимая роль".into()),
    }
}



fn require_role(
    app: &AppHandle,
    auth: &State<'_, AuthState>,
    session_token: &str,
    minimum: Role,
) -> Result<AppUser, String> {
    if app.try_state::<online_updates::UpdateState>().is_some_and(|state| state.applying.load(Ordering::SeqCst)) {
        return Err("UPDATING: приложение готовится к перезапуску; новые операции временно отложены".into());
    }
    if session_token.len() != 64 || !session_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("AUTH_REQUIRED: требуется вход".into());
    }
    let user_id = {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "AUTH_REQUIRED: состояние авторизации недоступно")?;
        let Some(record) = inner.sessions.get(session_token).cloned() else {
            return Err("AUTH_REQUIRED: сессия недействительна".into());
        };
        let now = now_ms();
        if now.saturating_sub(record.last_seen) > SESSION_IDLE_MS
            || now.saturating_sub(record.created_at) > SESSION_ABSOLUTE_MS
        {
            inner.sessions.remove(session_token);
            return Err("AUTH_REQUIRED: сессия истекла".into());
        }
        if let Some(record) = inner.sessions.get_mut(session_token) {
            record.last_seen = now;
        }
        record.user_id.clone()
    };
    let conn = open_db(app)?;
    let user = user_by_id(&conn, &user_id)?.ok_or("AUTH_REQUIRED: пользователь не найден")?;
    if !user.enabled {
        return Err("AUTH_REQUIRED: пользователь отключён".into());
    }
    if parse_role(&user.role)? < minimum {
        return Err("FORBIDDEN: недостаточно прав".into());
    }
    Ok(user)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    getrandom(&mut bytes)
        .map_err(|_| "Системный генератор случайных чисел недоступен".to_string())?;
    Ok(bytes)
}

fn validate_password(password: &str) -> Result<(), String> {
    let length = password.chars().count();
    if !(12..=128).contains(&length) {
        return Err("Пароль должен содержать от 12 до 128 символов".into());
    }
    if password.chars().any(char::is_control) {
        return Err("Пароль содержит недопустимые управляющие символы".into());
    }
    let classes = [
        password.chars().any(char::is_lowercase),
        password.chars().any(char::is_uppercase),
        password.chars().any(|value| value.is_ascii_digit()),
        password
            .chars()
            .any(|value| !value.is_alphanumeric() && !value.is_whitespace()),
    ]
    .into_iter()
    .filter(|value| *value)
    .count();
    if classes < 3 {
        return Err(
            "Используйте минимум три типа символов: строчные, прописные, цифры и знаки".into(),
        );
    }
    Ok(())
}

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> Result<[u8; 32], String> {
    let mut mac = HmacSha256::new_from_slice(password).map_err(|_| "Ошибка хеширования пароля")?;
    mac.update(salt);
    mac.update(&1_u32.to_be_bytes());
    let mut previous = mac.finalize().into_bytes();
    let mut output = previous;
    for _ in 1..iterations {
        let mut round =
            HmacSha256::new_from_slice(password).map_err(|_| "Ошибка хеширования пароля")?;
        round.update(&previous);
        previous = round.finalize().into_bytes();
        for (target, value) in output.iter_mut().zip(previous.iter()) {
            *target ^= *value;
        }
    }
    let mut result = [0_u8; 32];
    result.copy_from_slice(&output);
    Ok(result)
}



fn validate_pin(pin: &str) -> Result<(), String> {
    if pin.len() != 6 || !pin.bytes().all(|value| value.is_ascii_digit()) {
        return Err("PIN-код должен состоять ровно из 6 цифр".into());
    }
    Ok(())
}






const BOOTSTRAP_CREDENTIALS_SQL:&str="UPDATE users SET password_hash=?1,pin_hash=?2 WHERE id='admin' AND COALESCE(password_hash,'')='' AND COALESCE(pin_hash,'')=''";






#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HelloGrant { version: u8, user_id: String, credential_stamp: String }

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct HelloStatus { available: bool, enrolled: bool, detail: String }

pub(crate) struct HelloBusy(Arc<AtomicBool>);
impl Drop for HelloBusy { fn drop(&mut self){self.0.store(false,Ordering::Release);} }



fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"._:-".contains(&value))
    {
        return Err("Недопустимый ключ данных".into());
    }
    Ok(())
}



















fn validate_secret_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"._:-".contains(&value))
    {
        return Err("Недопустимый идентификатор секрета".into());
    }
    Ok(())
}

fn secret_entry(id: &str) -> Result<keyring::Entry, String> {
    validate_secret_id(id)?;
    keyring::Entry::new(SECRET_SERVICE, id).map_err(|e| e.to_string())
}

fn stored_api_key(printer_id: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = printer_id else {
        return Ok(None);
    };
    let entry = secret_entry(id)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Restoring saved actors is an availability optimization, not a prerequisite
/// for bringing up the authenticated local IPC endpoint.  In particular, a
/// headless process can run in a Windows session where Credential Manager is
/// temporarily unavailable even though printers without authentication remain
/// perfectly usable.  Do not turn that optional credential read into a daemon-
/// wide startup failure; the desktop sends the key again on its authenticated
/// `printer_actor_upsert` call when the store is available there.
pub(crate) fn stored_api_key_for_headless(printer_id: &str) -> Option<String> {
    match stored_api_key(Some(printer_id)) {
        Ok(value) => value,
        Err(error) => {
            let detail: String = error
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(300)
                .collect();
            crate::observability::record(
                "warn",
                "credential_store",
                "HEADLESS_CREDENTIAL_READ_SKIPPED",
                None,
                "Хранилище ключей недоступно headless-процессу; actor запущен без необязательного cached API key",
                serde_json::json!({"error":&detail}),
            );
            eprintln!(
                "klipper-farmd: optional credential store unavailable; continuing without cached API key: {detail}"
            );
            None
        }
    }
}

fn printer_target_bound(app: &AppHandle, printer_id: &str, host: &str) -> Result<bool, String> {
    let requested = parse_target(host, 7125)?;
    let conn = open_db(app)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM kv WHERE key='printers.config'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return Ok(false) };
    let configs: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "Сохранённая конфигурация принтеров повреждена")?;
    let Some(items) = configs.as_array() else {
        return Ok(false);
    };
    for item in items {
        if item.get("id").and_then(|value| value.as_str()) != Some(printer_id) {
            continue;
        }
        let Some(saved_host) = item.get("host").and_then(|value| value.as_str()) else {
            return Ok(false);
        };
        let saved = parse_target(saved_host, 7125)?;
        return Ok(same_printer_channel(&saved, &requested));
    }
    Ok(false)
}

fn same_printer_channel(saved: &HttpTarget, requested: &HttpTarget) -> bool {
    if saved.socket == requested.socket {
        return true;
    }
    saved.socket.ip() == requested.socket.ip()
        && matches!(saved.socket.port(), 80 | 7125)
        && matches!(requested.socket.port(), 80 | 7125)
}

fn authorize_printer_target(
    app: &AppHandle,
    user: &AppUser,
    printer_id: &str,
    host: &str,
) -> Result<(), String> {
    if printer_target_bound(app, printer_id, host)? {
        return Ok(());
    }
    if parse_role(&user.role)? == Role::Admin {
        parse_target(host, 7125)?;
        return Ok(());
    }
    Err("FORBIDDEN: адрес не совпадает с сохранённым принтером".into())
}

#[tauri::command]
fn headless_engine_status(
    app: AppHandle,
    auth: State<'_, AuthState>,
    client: State<'_, engine_client::EngineClient>,
    session_token: String,
) -> Result<engine_client::EngineStatusSnapshot, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    client.status_snapshot()
}











fn engine_owner_conflict(error: &str) -> bool {
    error.contains("ENGINE_ALREADY_RUNNING") || error.contains("HEADLESS_ENGINE_ACTIVE")
}

fn endpoint_allowed(method: &str, path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let route = path.split('?').next().unwrap_or(path);
    if lower.contains("%2e")
        || lower.contains("%5c")
        || lower.contains("%00")
        || route
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return false;
    }
    match method {
        "GET" => {
            path.starts_with("/server/temperature_store?")
                || path == "/server/webcams/list"
                || path.starts_with("/server/files/list?")
                || path.starts_with("/server/files/directory?")
                || path.starts_with("/server/history/list?")
                || path.starts_with("/server/history/job?")
                || path.starts_with("/server/files/metadata?")
                || path.starts_with("/server/files/thumbnails?")
                || path.starts_with("/server/files/gcodes/")
                || path == "/server/job_queue/status"
                || path == "/server/spoolman/status"
        }
        "DELETE" => path.starts_with("/server/files/gcodes/"),
        _ => false,
    }
}

#[tauri::command]
async fn moonraker_http(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    method: String,
    path: String,
    timeout_ms: Option<u64>,
    default_port: Option<u16>,
) -> Result<NativeHttpResponse, String> {
    let method = method.to_ascii_uppercase();
    let minimum = if method == "GET" {
        Role::Viewer
    } else {
        Role::Operator
    };
    let user = require_role(&app, &auth, &session_token, minimum)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if !endpoint_allowed(&method, &path) {
        return Err("Endpoint Moonraker не разрешён политикой безопасности".into());
    }
    let target = parse_target(&host, moonraker_default_port(default_port)?)?;
    let key = stored_api_key(Some(&printer_id))?;
    let scheduler = core.scheduler();
    let priority = if method == "DELETE" {
        transactional_core::types::OperationPriority::Control
    } else {
        transactional_core::types::OperationPriority::Background
    };
    let maximum = if path.starts_with("/server/files/gcodes/") {
        MAX_FILE_RESPONSE
    } else {
        MAX_JSON_RESPONSE
    };
    let response = bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
        let mut permit =
            scheduler.acquire_for_printer(&printer_id, priority, Duration::from_secs(15))?;
        let response = http_request(
            &target,
            &method,
            &path,
            key.as_deref(),
            None,
            &[],
            maximum,
            bounded_http_timeout(timeout_ms),
        );
        if response.is_ok() {
            permit.success();
        }
        response
    })
    .await
    .map_err(|e| format!("Moonraker HTTP worker failed: {e}"))??;
    Ok(NativeHttpResponse {
        status: response.status,
        content_type: response.content_type,
        body: response.body,
    })
}

#[tauri::command]
async fn creality_light(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    on: Option<bool>,
) -> Result<bool, String> {
    let minimum = if on.is_some() { Role::Operator } else { Role::Viewer };
    let user = require_role(&app, &auth, &session_token, minimum)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    let mut target = parse_target(&host, 7125)?;
    // Reuse the authorized/resolved address; callers cannot supply another
    // native destination, port, method or payload.
    target.socket.set_port(9999);
    target.authority = target.socket.to_string();
    let scheduler = core.scheduler();
    let priority = if on.is_some() {
        transactional_core::types::OperationPriority::Control
    } else {
        transactional_core::types::OperationPriority::Background
    };
    bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
        let mut permit = scheduler.acquire_for_printer(&printer_id, priority, Duration::from_secs(6))?;
        let result = creality_light::execute(&target, on);
        if result.is_ok() { permit.success(); }
        result
    }).await.map_err(|error| format!("Creality light worker failed: {error}"))?
}

fn safe_upload_name(name: &str) -> Result<String, String> {
    let basename = name.rsplit(['/', '\\']).next().unwrap_or("");
    if basename.is_empty()
        || basename.chars().count() > 180
        || name.chars().any(char::is_control)
        || basename.chars().any(|value| "\"<>:|?*".contains(value))
    {
        return Err("Недопустимое имя файла".into());
    }
    let lower = basename.to_ascii_lowercase();
    if !lower.ends_with(".gcode") && !lower.ends_with(".gco") {
        return Err("Разрешены только файлы .gcode и .gco".into());
    }
    // UTF-8 belongs to the original filename. Reject unsafe quoted multipart
    // names above rather than silently changing the file the user selected.
    Ok(basename.to_string())
}

#[cfg(test)]
mod upload_filename_tests {
    use super::safe_upload_name;

    #[test]
    fn original_unicode_names_and_spaces_are_preserved_exactly() {
        for name in [
            "Корпус К1С.gcode",
            "катушка 🧵.gco",
            "PLA_é — деталь (v2).GCODE",
            "два  пробела + 100%25;it's.gcode",
            "  пробел в начале.gcode",
        ] {
            assert_eq!(safe_upload_name(name).unwrap(), name);
        }
        assert_eq!(safe_upload_name(r"C:\jobs\Корпус 🧵.gcode").unwrap(), "Корпус 🧵.gcode");
        assert_eq!(safe_upload_name("/jobs/Корпус 🧵.gcode").unwrap(), "Корпус 🧵.gcode");
    }

    #[test]
    fn unsafe_upload_names_are_rejected_instead_of_renamed() {
        for name in [
            "bad\"name.gcode", "bad\r\nX-Injected: yes.gcode", "bad\0name.gcode",
            "bad<name.gcode", "bad>name.gcode", "bad:name.gcode", "bad|name.gcode",
            "bad?name.gcode", "bad*name.gcode", "bad\u{7f}name.gcode", "",
        ] {
            assert!(safe_upload_name(name).is_err(), "unsafe name was accepted: {name:?}");
        }
    }

    #[test]
    fn upload_name_character_and_extension_limits_are_preserved() {
        let maximum = format!("{}.gcode", "я".repeat(174));
        assert_eq!(safe_upload_name(&maximum).unwrap(), maximum);
        assert!(safe_upload_name(&format!("{}.gcode", "я".repeat(175))).is_err());
        assert!(safe_upload_name("деталь.gcode.exe").is_err());
    }
}

fn upload_to_moonraker_blocking(
    printer_key: &str,
    target: HttpTarget,
    key: Option<String>,
    filename: String,
    data: Vec<u8>,
    scheduler: &transactional_core::scheduler::FarmScheduler,
) -> Result<String, String> {
    let filename = safe_upload_name(&filename)?;
    if data.is_empty() || data.len() > MAX_UPLOAD {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let boundary = format!("KlipperFarm{}", hex::encode(random_bytes::<16>()?));
    let mut body = Vec::with_capacity(data.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&data);
    body.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n--{boundary}--\r\n"
        )
        .as_bytes(),
    );
    let content_type = format!("multipart/form-data; boundary={boundary}");
    scheduler.acquire_bandwidth_for(
        printer_key,
        data.len(),
        transactional_core::types::OperationPriority::Upload,
        Duration::from_secs(60),
        None,
    )?;
    let mut permit = scheduler.acquire_for_printer(
        printer_key,
        transactional_core::types::OperationPriority::Upload,
        Duration::from_secs(15),
    )?;
    let response = http_request(
        &target,
        "POST",
        "/server/files/upload",
        key.as_deref(),
        Some(&content_type),
        &body,
        MAX_JSON_RESPONSE,
        Duration::from_secs(60),
    );
    if response.is_ok() {
        permit.success();
    }
    let response = response?;
    legacy_upload_response_path(&response, &filename, data.len() as u64)
}

fn legacy_upload_response_path(
    response: &HttpResponse,
    filename: &str,
    expected_size: u64,
) -> Result<String, String> {
    if !(200..300).contains(&response.status) {
        return Err(transactional_core::upload::upload_http_error(response.status, &response.body));
    }
    let json: serde_json::Value = serde_json::from_slice(&response.body)
        .map_err(|error| format!("Moonraker upload returned invalid JSON: {error}"))?;
    if json.get("error").is_some_and(|value| !value.is_null()) {
        return Err(transactional_core::upload::upload_http_error(response.status, &response.body));
    }
    let returned_path = json
        .pointer("/result/item/path")
        .or_else(|| json.pointer("/item/path"))
        .and_then(serde_json::Value::as_str)
        .ok_or("Moonraker upload не подтвердил путь файла")?;
    let path = returned_path.strip_prefix("gcodes/").unwrap_or(returned_path);
    if path != filename {
        return Err("Moonraker загрузил файл по неожиданному пути".into());
    }
    if let Some(size) = json.pointer("/result/item/size").or_else(|| json.pointer("/item/size")) {
        if size.as_u64() != Some(expected_size) {
            return Err("Moonraker подтвердил неверный размер файла".into());
        }
    }
    Ok(path.to_string())
}

fn upload_verified_file_to_moonraker_blocking(
    printer_key: &str,
    target: HttpTarget,
    key: Option<String>,
    filename: String,
    source: PathBuf,
    expected_sha256: String,
    scheduler: &transactional_core::scheduler::FarmScheduler,
) -> Result<String, String> {
    let filename = safe_upload_name(&filename)?;
    let metadata =
        fs::symlink_metadata(&source).map_err(|_| "Файл не найден в локальной библиотеке")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Передавать можно только обычный G-code файл".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let parent = source
        .parent()
        .ok_or("Не удалось определить папку локального G-code")?;
    let temporary = parent.join(format!(
        ".klipper-farm-verified-upload-{}.tmp",
        hex::encode(random_bytes::<12>()?)
    ));
    let operation = (|| -> Result<String, String> {
        // Copy the validated bytes into a private immutable snapshot first.
        // This preserves the old TOCTOU guarantee without holding a 100 MiB
        // Vec in RAM: the exact snapshot that was hashed is the one uploaded.
        let mut input = fs::OpenOptions::new()
            .read(true)
            .open(&source)
            .map_err(|error| error.to_string())?;
        let mut snapshot = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        set_private_file_permissions(&temporary)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; MAX_UPLOAD_CHUNK];
        loop {
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .ok_or("Размер локального G-code переполнен")?;
            if copied > MAX_UPLOAD as u64 || copied > metadata.len() {
                return Err("Локальный G-code изменился во время проверки".into());
            }
            hasher.update(&buffer[..read]);
            snapshot
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
        }
        if copied != metadata.len() {
            return Err("Локальный G-code изменился во время проверки".into());
        }
        snapshot.sync_all().map_err(|error| error.to_string())?;
        let actual_sha256 = hex::encode(hasher.finalize());
        if !bool::from(
            actual_sha256
                .as_bytes()
                .ct_eq(expected_sha256.to_ascii_lowercase().as_bytes()),
        ) {
            return Err("G-code изменился после проверки. Запустите проверку повторно".into());
        }
        snapshot
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;

        let mut permit = scheduler.acquire_for_printer(
            printer_key,
            transactional_core::types::OperationPriority::Upload,
            Duration::from_secs(15),
        )?;
        let mut session = open_chunked_upload(
            target,
            key,
            filename.clone(),
            copied,
            String::new(),
            String::new(),
        )?;
        loop {
            let read = snapshot
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            scheduler.acquire_bandwidth_for(
                printer_key,
                read,
                transactional_core::types::OperationPriority::Upload,
                Duration::from_secs(60),
                None,
            )?;
            session
                .stream
                .write_all(&buffer[..read])
                .map_err(|error| format!("Moonraker upload write failed: {error}"))?;
            session.received_size += read as u64;
        }
        if session.received_size != session.expected_size {
            return Err("Проверенный G-code передан не полностью".into());
        }
        session
            .stream
            .write_all(&session.suffix)
            .map_err(|error| format!("Moonraker upload finish failed: {error}"))?;
        let response = read_http_response_from_stream(
            &mut session.stream,
            MAX_JSON_RESPONSE,
            Duration::from_secs(120),
        )?;
        let result = legacy_upload_response_path(&response, &filename, copied)?;
        permit.success();
        Ok(result)
    })();
    let _ = fs::remove_file(&temporary);
    operation
}

fn read_http_response_from_stream(
    stream: &mut TcpStream,
    maximum_response: usize,
    timeout: Duration,
) -> Result<HttpResponse, String> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or("Недопустимый сетевой тайм-аут")?;
    let wire_limit = maximum_response.saturating_add(1024 * 1024);
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Moonraker upload response timeout".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| error.to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if raw.len().saturating_add(read) > wire_limit {
                    return Err("HTTP-ответ Moonraker превышает допустимый размер".into());
                }
                raw.extend_from_slice(&buffer[..read]);
                if kf_moonraker::http_framing::response_boundary(&raw, maximum_response)? == kf_moonraker::http_framing::Boundary::Complete { break; }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err("Moonraker upload response timeout".into())
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    parse_http_response(&raw, maximum_response)
}

fn open_chunked_upload(
    target: HttpTarget,
    key: Option<String>,
    filename: String,
    expected_size: u64,
    printer_id: String,
    owner_id: String,
) -> Result<UploadSession, String> {
    let filename = safe_upload_name(&filename)?;
    if expected_size == 0 || expected_size > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    if let Some(value) = key.as_deref() {
        validate_header_value(value, 512)?;
    }
    let boundary = format!("KlipperFarm{}", hex::encode(random_bytes::<16>()?));
    let prefix = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    let suffix = format!(
        "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n--{boundary}--\r\n"
    )
    .into_bytes();
    let body_length = (prefix.len() as u64)
        .checked_add(expected_size)
        .and_then(|value| value.checked_add(suffix.len() as u64))
        .ok_or("Размер загрузки переполнен")?;
    if body_length > (MAX_UPLOAD + 1024 * 1024) as u64 {
        return Err("Тело HTTP-запроса слишком велико".into());
    }

    let mut stream = TcpStream::connect_timeout(&target.socket, Duration::from_secs(3))
        .map_err(|error| format!("Moonraker connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut headers = format!(
        "POST /server/files/upload HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\nContent-Length: {body_length}\r\nContent-Type: multipart/form-data; boundary={boundary}\r\n",
        target.authority
    );
    if let Some(value) = key.as_deref().filter(|value| !value.is_empty()) {
        headers.push_str(&format!("X-Api-Key: {value}\r\n"));
    }
    headers.push_str("\r\n");
    stream
        .write_all(headers.as_bytes())
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&prefix)
        .map_err(|error| error.to_string())?;
    Ok(UploadSession {
        stream,
        suffix,
        expected_size,
        received_size: 0,
        filename,
        printer_id,
        owner_id,
        started: Instant::now(),
        hasher: Sha256::new(),
    })
}

fn validate_upload_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Недопустимый ID загрузки".into());
    }
    Ok(())
}

#[tauri::command]
async fn moonraker_upload_begin(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    filename: String,
    file_size: u64,
    default_port: Option<u16>,
) -> Result<UploadBeginResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if file_size == 0 || file_size > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let target = parse_target(&host, moonraker_default_port(default_port)?)?;
    let key = stored_api_key(Some(&printer_id))?;
    let scheduler = core.scheduler();
    let upload_id = hex::encode(random_bytes::<16>()?);
    let sessions = Arc::clone(&uploads.sessions);
    {
        let mut items = sessions
            .lock()
            .map_err(|_| "Состояние загрузок недоступно")?;
        items.retain(|_, session| session.started.elapsed() < UPLOAD_SESSION_TTL);
        if items.len() >= MAX_TRANSFER_SESSIONS {
            return Err("Слишком много одновременных загрузок G-code".into());
        }
    }
    let session = bounded_spawn_blocking(ExecutionClass::FileIo, {
        let owner_id = user.id.clone();
        let printer_id = printer_id.clone();
        move || {
            let mut permit = scheduler.acquire_for_printer(
                &printer_id,
                transactional_core::types::OperationPriority::Upload,
                Duration::from_secs(15),
            )?;
            let session =
                open_chunked_upload(target, key, filename, file_size, printer_id, owner_id);
            if session.is_ok() {
                permit.success();
            }
            session
        }
    })
    .await
    .map_err(|error| format!("Moonraker upload begin worker failed: {error}"))??;
    let mut items = sessions
        .lock()
        .map_err(|_| "Состояние загрузок недоступно")?;
    if items.len() >= MAX_TRANSFER_SESSIONS {
        return Err("Слишком много одновременных загрузок G-code".into());
    }
    if items.contains_key(&upload_id) {
        return Err("Конфликт ID загрузки — повторите операцию".into());
    }
    items.insert(upload_id.clone(), session);
    Ok(UploadBeginResult {
        upload_id,
        chunk_size: MAX_UPLOAD_CHUNK,
    })
}

#[tauri::command]
async fn moonraker_upload_chunk(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    upload_id: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<u64, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_upload_id(&upload_id)?;
    if data.is_empty() || data.len() > MAX_UPLOAD_CHUNK {
        return Err("Некорректный блок G-code".into());
    }
    let scheduler = core.scheduler();
    let sessions = Arc::clone(&uploads.sessions);
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let mut session = {
            let mut items = sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?;
            items
                .remove(&upload_id)
                .ok_or("Сессия загрузки не найдена")?
        };
        if session.owner_id != user.id {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("FORBIDDEN: загрузка принадлежит другому пользователю".into());
        }
        if session.started.elapsed() >= UPLOAD_SESSION_TTL {
            return Err("Сессия загрузки истекла".into());
        }
        if offset != session.received_size
            || session.received_size.saturating_add(data.len() as u64) > session.expected_size
        {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("Нарушен порядок блоков G-code".into());
        }
        if let Err(error) = scheduler.acquire_bandwidth_for(
            &session.printer_id,
            data.len(),
            transactional_core::types::OperationPriority::Upload,
            Duration::from_secs(60),
            None,
        ) {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err(error);
        }
        session
            .stream
            .write_all(&data)
            .map_err(|error| format!("Moonraker upload write failed: {error}"))?;
        session.hasher.update(&data);
        session.received_size += data.len() as u64;
        let received = session.received_size;
        sessions
            .lock()
            .map_err(|_| "Состояние загрузок недоступно")?
            .insert(upload_id, session);
        Ok(received)
    })
    .await
    .map_err(|error| format!("Moonraker upload chunk worker failed: {error}"))?
}

#[tauri::command]
async fn moonraker_upload_finish(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    upload_id: String,
) -> Result<UploadFinishResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    let owner_id = user.id.clone();
    validate_upload_id(&upload_id)?;
    let scheduler = core.scheduler();
    let sessions = Arc::clone(&uploads.sessions);
    let (result, printer_id) = bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let mut session = {
            let mut items = sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?;
            items
                .remove(&upload_id)
                .ok_or("Сессия загрузки не найдена")?
        };
        if session.owner_id != owner_id {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("FORBIDDEN: загрузка принадлежит другому пользователю".into());
        }
        if session.received_size != session.expected_size {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("G-code передан не полностью".into());
        }
        let mut permit = match scheduler.acquire_for_printer(
            &session.printer_id,
            transactional_core::types::OperationPriority::Upload,
            Duration::from_secs(15),
        ) {
            Ok(permit) => permit,
            Err(error) => {
                sessions
                    .lock()
                    .map_err(|_| "Состояние загрузок недоступно")?
                    .insert(upload_id, session);
                return Err(error);
            }
        };
        session
            .stream
            .write_all(&session.suffix)
            .map_err(|error| format!("Moonraker upload finish failed: {error}"))?;
        let response = read_http_response_from_stream(
            &mut session.stream,
            MAX_JSON_RESPONSE,
            Duration::from_secs(120),
        )?;
        if !(200..300).contains(&response.status) {
            return Err(format!("Upload HTTP {}", response.status));
        }
        let json: serde_json::Value =
            serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
        let path = json
            .pointer("/result/item/path")
            .and_then(|value| value.as_str())
            .unwrap_or(&session.filename)
            .to_string();
        let result = UploadFinishResult {
            path,
            sha256: hex::encode(session.hasher.finalize()),
        };
        permit.success();
        Ok((result, session.printer_id))
    })
    .await
    .map_err(|error| format!("Moonraker upload finish worker failed: {error}"))??;
    insert_audit(
        &app,
        &user.id,
        "gcode.upload_stream",
        &format!("{} · {}", printer_id, result.path),
    )?;
    Ok(result)
}

#[tauri::command]
fn moonraker_upload_abort(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    session_token: String,
    upload_id: String,
) -> Result<bool, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_upload_id(&upload_id)?;
    let mut items = uploads
        .sessions
        .lock()
        .map_err(|_| "Состояние загрузок недоступно")?;
    let Some(session) = items.remove(&upload_id) else {
        return Ok(false);
    };
    if session.owner_id != user.id {
        items.insert(upload_id, session);
        return Err("FORBIDDEN: загрузка принадлежит другому пользователю".into());
    }
    Ok(true)
}

#[tauri::command]
async fn moonraker_upload(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    filename: String,
    data: Vec<u8>,
    default_port: Option<u16>,
) -> Result<String, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if data.is_empty() || data.len() > MAX_UPLOAD {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let target = parse_target(&host, moonraker_default_port(default_port)?)?;
    let key = stored_api_key(Some(&printer_id))?;
    let scheduler = core.scheduler();
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        upload_to_moonraker_blocking(&printer_id, target, key, filename, data, &scheduler)
    })
    .await
    .map_err(|e| format!("Moonraker upload worker failed: {e}"))?
}

fn snapshot_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = storage_paths::subdir(app, "print-snapshots")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(directory)
}

fn snapshot_extension(content_type: &str, data: &[u8]) -> Result<&'static str, String> {
    let kind = content_type.to_ascii_lowercase();
    if (kind.starts_with("image/jpeg") || kind.starts_with("image/jpg"))
        && data.starts_with(&[0xff, 0xd8, 0xff])
    {
        return Ok("jpg");
    }
    if kind.starts_with("image/png") && data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Ok("png");
    }
    if kind.starts_with("image/webp")
        && data.len() >= 12
        && &data[..4] == b"RIFF"
        && &data[8..12] == b"WEBP"
    {
        return Ok("webp");
    }
    Err("Снимок имеет неподдерживаемый формат".into())
}



#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
mod login_method_tests {
    use super::*;
    fn database()->Connection{let db=Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT,pin_hash TEXT); INSERT INTO users(id)VALUES('admin');").unwrap();db}
    #[test]
    fn pin_only_setup_cannot_be_reset_by_another_bootstrap(){
        let db=database();assert!(!auth_credentials_configured(&db).unwrap());
        assert_eq!(db.execute(BOOTSTRAP_CREDENTIALS_SQL,params![Option::<String>::None,"pin-hash"]).unwrap(),1);
        assert!(auth_credentials_configured(&db).unwrap());
        assert_eq!(db.execute(BOOTSTRAP_CREDENTIALS_SQL,params!["replacement",Option::<String>::None]).unwrap(),0);
        let pin:String=db.query_row("SELECT pin_hash FROM users WHERE id='admin'",[],|r|r.get(0)).unwrap();assert_eq!(pin,"pin-hash");
    }
    #[test]
    fn pin_removal_cannot_remove_the_only_login_method(){let db=database();db.execute(BOOTSTRAP_CREDENTIALS_SQL,params![Option::<String>::None,"pin-hash"]).unwrap();assert!(ensure_pin_removal_keeps_access(&db,"admin",true,false).is_err());assert!(ensure_pin_removal_keeps_access(&db,"admin",false,false).is_ok());assert!(ensure_pin_removal_keeps_access(&db,"admin",true,true).is_ok());db.execute("UPDATE users SET password_hash='password-hash'",[]).unwrap();assert!(ensure_pin_removal_keeps_access(&db,"admin",true,false).is_ok());}
    #[test]
    fn legacy_password_setup_remains_configured(){let db=database();db.execute(BOOTSTRAP_CREDENTIALS_SQL,params!["old-password-hash",Option::<String>::None]).unwrap();assert!(auth_credentials_configured(&db).unwrap());assert_eq!(db.execute(BOOTSTRAP_CREDENTIALS_SQL,params![Option::<String>::None,"new-pin"]).unwrap(),0);}
    #[test]
    fn hello_grant_is_bound_to_account_version_and_current_credentials(){let stamp="a".repeat(64);let mut grant=HelloGrant{version:1,user_id:"admin".into(),credential_stamp:stamp.clone()};assert!(hello_grant_matches(&grant,"admin",&stamp));assert!(!hello_grant_matches(&grant,"operator",&stamp));assert!(!hello_grant_matches(&grant,"admin",&"b".repeat(64)));grant.version=2;assert!(!hello_grant_matches(&grant,"admin",&stamp));grant.version=1;grant.credential_stamp="".into();assert!(!hello_grant_matches(&grant,"admin",&stamp));}
    #[test]
    fn hello_single_flight_releases_after_failure(){let busy=Arc::new(AtomicBool::new(false));assert!(busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_ok());let guard=HelloBusy(busy.clone());assert!(busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err());drop(guard);assert!(!busy.load(Ordering::Acquire));}
}

#[cfg(test)]
mod auth_core_tests {
    use super::*;

    /// Проба: доказывает, что аутентификацию можно проверять на базе в памяти,
    /// не трогая настоящий файл базы и не поднимая Tauri.
    /// Настоящая схема, а не выдуманная: if схема разойдётся с боевой, тесты
    /// должны упасть здесь, а не промолчать.
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::database::initialize_base_schema(&db).unwrap();
        db
    }

    #[test]
    fn password_round_trip_and_rejection() {
        let encoded = hash_password("KlipperFarm-2026!").unwrap();
        assert!(verify_password("KlipperFarm-2026!", &encoded));
        assert!(!verify_password("KlipperFarm-2026", &encoded));
        assert!(!verify_password("klipperfarm-2026!", &encoded));
    }

    #[test]
    fn password_hash_carries_its_own_parameters() {
        let encoded = hash_password("KlipperFarm-2026!").unwrap();
        let parts: Vec<_> = encoded.split('$').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "pbkdf2-sha256");
        assert_eq!(parts[1], PASSWORD_ITERATIONS.to_string());
        // Соль своя у каждого хеша: одинаковые пароли дают разные значения.
        assert_ne!(encoded, hash_password("KlipperFarm-2026!").unwrap());
    }

    #[test]
    fn weak_passwords_are_refused_before_hashing() {
        for weak in ["", "short1", "только буквы", "123456789012"] {
            assert!(hash_password(weak).is_err(), "принят слабый пароль: {weak}");
        }
    }

    #[test]
    fn tampered_hash_is_rejected_rather_than_matching() {
        let encoded = hash_password("KlipperFarm-2026!").unwrap();
        let parts: Vec<&str> = encoded.split('$').collect();
        // Нижняя граница итераций — защита от подмены на дешёвый хеш. Проверяем
        // именно её: собираем ПРАВИЛЬНЫЙ хеш с одной итерацией. Совпадение есть,
        // а отказать всё равно обязано — иначе проверка границы ничего не стоит.
        let salt = hex::decode(parts[2]).unwrap();
        let cheap = pbkdf2_sha256(b"KlipperFarm-2026!", &salt, 1).unwrap();
        let weak = format!("pbkdf2-sha256$1${}${}", parts[2], hex::encode(cheap));
        assert_eq!(
            pbkdf2_sha256(b"KlipperFarm-2026!", &salt, 1).unwrap(),
            cheap,
            "хеш с одной итерацией должен вычисляться"
        );
        assert!(!verify_password("KlipperFarm-2026!", &weak), "принят хеш с одной итерацией");
        // Испорченная соль не должна считаться совпадением.
        let bad_salt = format!("pbkdf2-sha256${}${}${}", parts[1], "00".repeat(16), parts[3]);
        assert!(!verify_password("KlipperFarm-2026!", &bad_salt));
        for garbage in ["", "не-хеш", "pbkdf2-sha256$310000$zz$zz"] {
            assert!(!verify_password("KlipperFarm-2026!", garbage));
        }
    }

    #[test]
    fn pin_is_salted_per_user_and_verified() {
        let alice = hash_pin("123456").unwrap();
        let bob = hash_pin("123456").unwrap();
        assert_ne!(alice, bob, "один PIN у двух пользователей дал одинаковый хеш");
        assert!(verify_pin("123456", &alice));
        assert!(!verify_pin("123457", &alice));
    }

    #[test]
    fn credentials_configured_reflects_the_row_not_the_cache() {
        let db = database();
        assert!(!auth_credentials_configured(&db).unwrap());
        let changed = db
            .execute(
                BOOTSTRAP_CREDENTIALS_SQL,
                params![Option::<String>::None, "pin-hash"],
            )
            .unwrap();
        // Строка администратора создаётся схемой; если это перестанет быть так,
        // тест обязан упасть, а не пройти на пустой таблице.
        assert_eq!(changed, 1, "BOOTSTRAP не обновил ни одной строки");
        assert!(auth_credentials_configured(&db).unwrap());
    }

    #[test]
    fn removing_the_last_way_in_is_refused() {
        let db = database();
        db.execute(
            BOOTSTRAP_CREDENTIALS_SQL,
            params![Option::<String>::None, "pin-hash"],
        )
        .unwrap();
        // PIN — единственный способ входа: убрать его нельзя.
        assert!(ensure_pin_removal_keeps_access(&db, "admin", true, false).is_err());
        // Пароль есть — PIN убрать можно.
        db.execute(
            "UPDATE users SET password_hash='hash' WHERE id='admin'",
            [],
        )
        .unwrap();
        assert!(ensure_pin_removal_keeps_access(&db, "admin", true, false).is_ok());
    }

    #[test]
    fn users_are_read_back_without_credentials() {
        let db = database();
        db.execute(
            BOOTSTRAP_CREDENTIALS_SQL,
            params![Some("password-hash"), Option::<String>::None],
        )
        .unwrap();
        let users = users_list_internal(&db).unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].role, "admin");
        assert!(!users[0].pin_enabled);
        let found = user_by_id(&db, "admin").unwrap().unwrap();
        assert_eq!(found.id, "admin");
    }
}