#![allow(clippy::too_many_arguments)]


// Протокол вынесен в rpc.rs; имена остаются доступны как crate::имя,
// чтобы вызовы в остальных модулях не менялись.
// Пути локальной библиотеки вынесены; имена остаются доступны как crate::имя.
// Три функции ниже зависят от Tauri-состояния (AppHandle), поэтому остаются
// в корне: они не чистые преобразования путей, а доступ к каталогу данных.
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

// Две нужны самому корню; остальные — модулю и его тестам.
pub(crate) use local_library_commands::{
    create_local_library_parent, local_library_root, snapshot_directory, snapshot_extension,
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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, Write},
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
mod upload_commands;
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

// Команды загрузки: их макросы __cmd__* генерируются рядом с определениями,
// поэтому для generate_handler! нужен импорт из модуля, а не реэкспорт.
#[allow(unused_imports)]
use crate::upload_commands::*;
// Команды вынесены в auth_commands; имена остаются доступны как crate::имя,
// чтобы invoke_handler и остальной код не менялись.
pub(crate) use auth_commands::{require_role, validate_key};
#[cfg(test)]
pub(crate) use auth_commands::validate_password;
#[cfg(test)]
pub(crate) use auth_commands::pbkdf2_sha256;
pub(crate) use auth_commands::{
    auth_bootstrap, auth_change_password, auth_hello_disable, auth_hello_enable, auth_hello_login,
    auth_hello_status, auth_login, auth_logout, auth_pin_login, auth_status, user_delete, user_save,
    users_list,
};
// Эти нужны и корню, и auth_policy, и тестам: реэкспорт без cfg.
pub(crate) use auth_commands::{users_list_internal, validate_user_id};
#[cfg(test)]
pub(crate) use auth_commands::user_by_id;
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
pub(crate) const SESSION_IDLE_MS: i64 = 8 * 60 * 60 * 1000;
pub(crate) const SESSION_ABSOLUTE_MS: i64 = 24 * 60 * 60 * 1000;
const FAILURE_RECORD_TTL_MS: i64 = 30 * 60 * 1000;
#[allow(dead_code)] // используется модулем auth_policy
const MAX_FAILURE_RECORDS: usize = 1_024;
const GLOBAL_FAILURE_LIMIT: u8 = 50;
const MAX_JSON_RESPONSE: usize = 2 * 1024 * 1024;
pub(crate) const MAX_FILE_RESPONSE: usize = 32 * 1024 * 1024;
pub(crate) const MAX_UPLOAD: usize = 100 * 1024 * 1024;
pub(crate) const MAX_UPLOAD_CHUNK: usize = 512 * 1024;
pub(crate) const UPLOAD_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
pub(crate) const MAX_TRANSFER_SESSIONS: usize = 8;
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
pub(crate) struct UploadState {
    sessions: Arc<Mutex<HashMap<String, UploadSession>>>,
}

pub(crate) struct UploadSession {
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
pub(crate) struct UploadBeginResult {
    upload_id: String,
    chunk_size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadFinishResult {
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
pub(crate) struct NativeHttpResponse {
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
























fn parse_role(value: &str) -> Result<Role, String> {
    match value {
        "admin" => Ok(Role::Admin),
        "operator" => Ok(Role::Operator),
        "viewer" => Ok(Role::Viewer),
        _ => Err("Недопустимая роль".into()),
    }
}




fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    getrandom(&mut bytes)
        .map_err(|_| "Системный генератор случайных чисел недоступен".to_string())?;
    Ok(bytes)
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