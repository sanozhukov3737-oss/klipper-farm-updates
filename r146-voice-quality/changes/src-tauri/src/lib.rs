#![allow(clippy::too_many_arguments)]

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
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

mod creality_light;
mod windows_hello;
mod audit_chain;
mod core_error;
mod database;
mod desktop_startup;
mod discovery_commands;
#[cfg(windows)]
mod desktop_job;
mod engine_client;
mod filament_inventory;
mod local_library_commands;
mod offline_voice;
pub mod headless_engine;
mod moonraker_protocol;
mod observability;
mod online_updates;
mod update_cache;
mod system_commands;
mod transactional_core;

pub(crate) use database::{db_path, open_db};
use online_updates::{update_apply, update_cancel, update_check, update_install, update_status};
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
    transactional_upload_list, verification_replay_plan, InstanceLease, TransactionalCore,
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
const MAX_DISCOVERY_RESULTS: usize = 64;
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

fn discovery_source_rank(source: Option<&str>) -> u8 {
    match source {
        Some("stable_id") => 0,
        Some("mdns") => 1,
        Some("ssdp") => 2,
        Some("known_host") => 3,
        Some("arp") => 4,
        Some("manual") => 5,
        Some("subnet_scan") => 6,
        _ => 7,
    }
}

fn discovery_identity(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
}

fn same_discovered_printer(left: &DiscoveredPrinter, right: &DiscoveredPrinter) -> bool {
    if discovery_identity_conflicts(left, right) {
        return false;
    }
    if discovery_identity_match(left, right) {
        return true;
    }
    left.ip == right.ip
        || discovery_identity(left.hostname.as_deref())
            .zip(discovery_identity(right.hostname.as_deref()))
            .is_some_and(|(left, right)| left == right)
}

fn discovery_identity_match(left: &DiscoveredPrinter, right: &DiscoveredPrinter) -> bool {
    discovery_identity(left.stable_id.as_deref())
        .zip(discovery_identity(right.stable_id.as_deref()))
        .is_some_and(|(left, right)| left == right)
        || discovery_identity(left.moonraker_uuid.as_deref())
            .zip(discovery_identity(right.moonraker_uuid.as_deref()))
            .is_some_and(|(left, right)| left == right)
}

fn discovery_identity_conflicts(left: &DiscoveredPrinter, right: &DiscoveredPrinter) -> bool {
    let left_uuid = discovery_identity(left.moonraker_uuid.as_deref());
    let right_uuid = discovery_identity(right.moonraker_uuid.as_deref());
    if let (Some(left), Some(right)) = (left_uuid, right_uuid) {
        return left != right;
    }
    discovery_identity(left.stable_id.as_deref())
        .zip(discovery_identity(right.stable_id.as_deref()))
        .is_some_and(|(left, right)| left != right)
}

fn discovery_identity_labels(printer: &DiscoveredPrinter) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(value) = discovery_identity(printer.stable_id.as_deref()) {
        values.push(format!("stable:{value}"));
    }
    if let Some(value) = discovery_identity(printer.moonraker_uuid.as_deref()) {
        values.push(format!("uuid:{value}"));
    }
    values
}

fn mark_discovery_conflict(
    printer: &mut DiscoveredPrinter,
    code: &str,
    hosts: impl IntoIterator<Item = String>,
    identities: impl IntoIterator<Item = String>,
) {
    if printer.identity_conflict.is_none() {
        printer.identity_conflict = Some(code.to_string());
    }
    printer.conflict_hosts.extend(hosts);
    printer.conflict_hosts.sort();
    printer.conflict_hosts.dedup();
    printer.conflict_identities.extend(identities);
    printer.conflict_identities.sort();
    printer.conflict_identities.dedup();
}

fn discovery_result_rank(printer: &DiscoveredPrinter) -> (u8, u8, u8) {
    let state = if printer.moonraker_confirmed && !printer.auth_required {
        0
    } else if printer.auth_required {
        1
    } else if printer.probe_state == "http_response" {
        2
    } else {
        3
    };
    (
        state,
        if printer.port == 7125 { 0 } else { 1 },
        discovery_source_rank(printer.source.as_deref()),
    )
}

fn dedupe_discovered_printers(mut printers: Vec<DiscoveredPrinter>) -> Vec<DiscoveredPrinter> {
    printers.sort_by_key(discovery_result_rank);
    let mut merged: Vec<DiscoveredPrinter> = Vec::with_capacity(printers.len());
    for mut printer in printers {
        for current in &mut merged {
            if !discovery_identity_conflicts(current, &printer) {
                continue;
            }
            let same_ip = current.ip == printer.ip;
            let same_hostname = discovery_identity(current.hostname.as_deref())
                .zip(discovery_identity(printer.hostname.as_deref()))
                .is_some_and(|(left, right)| left == right);
            if !same_ip && !same_hostname {
                continue;
            }
            let code = if same_ip {
                "address_identity_collision"
            } else {
                "hostname_identity_collision"
            };
            let hosts = [current.host.clone(), printer.host.clone()];
            let identities = discovery_identity_labels(current)
                .into_iter()
                .chain(discovery_identity_labels(&printer))
                .collect::<Vec<_>>();
            mark_discovery_conflict(current, code, hosts.clone(), identities.clone());
            mark_discovery_conflict(&mut printer, code, hosts, identities);
        }
        let Some(current) = merged
            .iter_mut()
            .find(|current| same_discovered_printer(current, &printer))
        else {
            merged.push(printer);
            continue;
        };
        if discovery_identity_match(current, &printer) && current.ip != printer.ip {
            let hosts = [current.host.clone(), printer.host.clone()];
            let identities = discovery_identity_labels(current)
                .into_iter()
                .chain(discovery_identity_labels(&printer))
                .collect::<Vec<_>>();
            mark_discovery_conflict(
                current,
                "identity_multiple_addresses",
                hosts,
                identities,
            );
        }
        if current.stable_id.is_none() {
            current.stable_id = printer.stable_id.clone();
        }
        if current.klippy_state.is_none() {
            current.klippy_state = printer.klippy_state.clone();
        }
        if current.moonraker_version.is_none() {
            current.moonraker_version = printer.moonraker_version.clone();
        }
        if current.hostname.is_none() {
            current.hostname = printer.hostname.clone();
        }
        if current.moonraker_uuid.is_none() {
            current.moonraker_uuid = printer.moonraker_uuid.clone();
        }
        if current.http_status.is_none() {
            current.http_status = printer.http_status;
        }
        if current.working_protocol.is_none() {
            current.working_protocol = printer.working_protocol.clone();
            current.working_port = printer.working_port;
        }
        current.moonraker_confirmed |= printer.moonraker_confirmed;
        if current.identity_conflict.is_none() {
            current.identity_conflict = printer.identity_conflict;
        }
        current.conflict_hosts.extend(printer.conflict_hosts);
        current.conflict_hosts.sort();
        current.conflict_hosts.dedup();
        current.conflict_identities.extend(printer.conflict_identities);
        current.conflict_identities.sort();
        current.conflict_identities.dedup();
        if discovery_source_rank(printer.source.as_deref())
            < discovery_source_rank(current.source.as_deref())
        {
            current.source = printer.source;
        }
    }
    merged.truncate(MAX_DISCOVERY_RESULTS);
    merged
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
struct AuthStatus {
    needs_setup: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
    token: String,
    user: AppUser,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    user_id: String,
    created_at: i64,
    last_seen: i64,
}

#[derive(Debug, Clone, Default)]
struct FailureRecord {
    count: u8,
    locked_until: i64,
    last_seen: i64,
}

#[derive(Default)]
struct AuthInner {
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

fn local_library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
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

fn windows_reserved_segment(value: &str) -> bool {
    let stem = value
        .trim_end_matches([' ', '.'])
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|number| number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9'))
}

fn normalize_local_library_segments(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty()
        || value.len() > MAX_LOCAL_LIBRARY_PATH
        || value.chars().any(char::is_control)
    {
        return Err("Недопустимый путь в локальной библиотеке".into());
    }
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err("Путь локальной библиотеки должен быть относительным".into());
    }
    let path = Path::new(&normalized);
    let mut segments = Vec::new();
    for component in path.components() {
        let Component::Normal(segment) = component else {
            return Err("Переходы между каталогами запрещены".into());
        };
        let segment = segment
            .to_str()
            .ok_or("Путь локальной библиотеки должен быть в UTF-8")?;
        if segment.is_empty()
            || segment.len() > 180
            || segment == "."
            || segment == ".."
            || segment.ends_with([' ', '.'])
            || segment
                .chars()
                .any(|character| "<>:\"|?*".contains(character))
            || windows_reserved_segment(segment)
        {
            return Err("Путь содержит недопустимое имя папки или файла".into());
        }
        segments.push(segment.to_string());
        if segments.len() > 48 {
            return Err("Слишком глубокая структура папок".into());
        }
    }
    if segments.is_empty() {
        return Err("Корневой каталог локальной библиотеки удалять нельзя".into());
    }
    Ok(segments)
}

fn normalize_local_library_path(value: &str) -> Result<String, String> {
    let segments = normalize_local_library_segments(value)?;
    let normalized = segments.join("/");
    let lower = normalized.to_ascii_lowercase();
    if !lower.ends_with(".gcode") && !lower.ends_with(".gco") {
        return Err("Разрешены только файлы .gcode и .gco".into());
    }
    Ok(normalized)
}

fn normalize_local_library_directory(value: &str) -> Result<String, String> {
    Ok(normalize_local_library_segments(value)?.join("/"))
}

fn local_library_file_path(root: &Path, value: &str) -> Result<(String, PathBuf), String> {
    let normalized = normalize_local_library_path(value)?;
    let mut path = root.to_path_buf();
    for segment in normalized.split('/') {
        path.push(segment);
    }
    Ok((normalized, path))
}

fn local_library_directory_path(root: &Path, value: &str) -> Result<(String, PathBuf), String> {
    let normalized = normalize_local_library_directory(value)?;
    let mut path = root.to_path_buf();
    for segment in normalized.split('/') {
        path.push(segment);
    }
    Ok((normalized, path))
}

fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    #[cfg(not(any(unix, windows)))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    restrict_windows_acl(path, true)?;
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(not(any(unix, windows)))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    restrict_windows_acl(path, false)?;
    Ok(())
}

#[cfg(windows)]
fn restrict_windows_acl(path: &Path, directory: bool) -> Result<(), String> {
    let output = windowless_windows_command("whoami.exe")
        .args(["/user", "/fo", "table", "/nh"])
        .output()
        .map_err(|error| format!("WINDOWS_SID_TOOL_FAILED: {error}"))?;
    if !output.status.success() {
        return Err(format!("WINDOWS_SID_TOOL_REJECTED: {}", output.status));
    }
    let sid = parse_windows_sid(&output.stdout).ok_or("WINDOWS_CURRENT_USER_SID_MISSING")?;
    let principal = format!("*{sid}");
    let rights = if directory { "(OI)(CI)F" } else { "F" };
    let output = windowless_windows_command("icacls.exe")
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            &format!("{principal}:{rights}"),
            "/grant:r",
            if directory {
                "*S-1-5-18:(OI)(CI)F"
            } else {
                "*S-1-5-18:F"
            },
            "/Q",
        ])
        .output()
        .map_err(|error| format!("WINDOWS_ACL_TOOL_FAILED: {error}"))?;
    if !output.status.success() {
        return Err(format!("WINDOWS_ACL_REJECTED: {}", output.status));
    }
    Ok(())
}

#[cfg(windows)]
fn windowless_windows_command(program: &str) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn windowless_windows_command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

#[cfg(any(windows, test))]
fn parse_windows_sid(output: &[u8]) -> Option<String> {
    String::from_utf8_lossy(output)
        .split_ascii_whitespace()
        .map(|value| value.trim_matches(['"', '\r', '\n']).to_ascii_uppercase())
        .find(|value| {
            value.len() <= 184
                && value.starts_with("S-1-")
                && value
                    .split('-')
                    .skip(1)
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                && value.split('-').count() >= 4
        })
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

fn user_by_id(conn: &Connection, id: &str) -> Result<Option<AppUser>, String> {
    conn.query_row(
        "SELECT id,name,role,enabled,created_at,(pin_hash IS NOT NULL AND pin_hash!='') FROM users WHERE id=?1",
        params![id],
        |row| {
            Ok(AppUser {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                pin_enabled: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn users_list_internal(conn: &Connection) -> Result<Vec<AppUser>, String> {
    let mut statement = conn
        .prepare("SELECT id,name,role,enabled,created_at,(pin_hash IS NOT NULL AND pin_hash!='') FROM users ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(AppUser {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                pin_enabled: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
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

fn hash_password(password: &str) -> Result<String, String> {
    validate_password(password)?;
    let salt = random_bytes::<16>()?;
    let hash = pbkdf2_sha256(password.as_bytes(), &salt, PASSWORD_ITERATIONS)?;
    Ok(format!(
        "pbkdf2-sha256${}${}${}",
        PASSWORD_ITERATIONS,
        hex::encode(salt),
        hex::encode(hash)
    ))
}

fn verify_password(password: &str, encoded: &str) -> bool {
    let parts: Vec<_> = encoded.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    if !(100_000..=1_000_000).contains(&iterations) {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (hex::decode(parts[2]), hex::decode(parts[3])) else {
        return false;
    };
    if salt.len() < 16 || expected.len() != 32 {
        return false;
    }
    let Ok(actual) = pbkdf2_sha256(password.as_bytes(), &salt, iterations) else {
        return false;
    };
    bool::from(actual.as_slice().ct_eq(expected.as_slice()))
}

fn validate_pin(pin: &str) -> Result<(), String> {
    if pin.len() != 6 || !pin.bytes().all(|value| value.is_ascii_digit()) {
        return Err("PIN-код должен состоять ровно из 6 цифр".into());
    }
    Ok(())
}

fn pin_material(pin: &str) -> Vec<u8> {
    let mut value = b"KlipperFarmPIN\0".to_vec();
    value.extend_from_slice(pin.as_bytes());
    value
}

fn hash_pin(pin: &str) -> Result<String, String> {
    validate_pin(pin)?;
    let salt = random_bytes::<16>()?;
    let hash = pbkdf2_sha256(&pin_material(pin), &salt, PIN_ITERATIONS)?;
    Ok(format!(
        "pbkdf2-sha256-pin${}${}${}",
        PIN_ITERATIONS,
        hex::encode(salt),
        hex::encode(hash)
    ))
}

fn verify_pin(pin: &str, encoded: &str) -> bool {
    if validate_pin(pin).is_err() {
        return false;
    }
    let parts: Vec<_> = encoded.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256-pin" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    if !(100_000..=1_000_000).contains(&iterations) {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (hex::decode(parts[2]), hex::decode(parts[3])) else {
        return false;
    };
    if salt.len() < 16 || expected.len() != 32 {
        return false;
    }
    let Ok(actual) = pbkdf2_sha256(&pin_material(pin), &salt, iterations) else {
        return false;
    };
    bool::from(actual.as_slice().ct_eq(expected.as_slice()))
}

fn new_session(auth: &State<'_, AuthState>, user: AppUser) -> Result<AuthSession, String> {
    let token = hex::encode(random_bytes::<32>()?);
    let created_at = now_ms();
    auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?
        .sessions
        .insert(
            token.clone(),
            SessionRecord {
                user_id: user.id.clone(),
                created_at,
                last_seen: created_at,
            },
        );
    Ok(AuthSession { token, user })
}

fn insert_audit(app: &AppHandle, user: &str, action: &str, details: &str) -> Result<(), String> {
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

fn auth_credentials_configured(conn:&Connection)->Result<bool,String>{
    conn.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id='admin' AND (COALESCE(password_hash,'')!='' OR COALESCE(pin_hash,'')!=''))",[],|row|row.get(0)).map_err(|e|e.to_string())
}
const BOOTSTRAP_CREDENTIALS_SQL:&str="UPDATE users SET password_hash=?1,pin_hash=?2 WHERE id='admin' AND COALESCE(password_hash,'')='' AND COALESCE(pin_hash,'')=''";

#[tauri::command]
fn auth_status(app: AppHandle) -> Result<AuthStatus, String> {
    let conn = open_db(&app)?;
    let configured=auth_credentials_configured(&conn)?;
    Ok(AuthStatus { needs_setup: !configured })
}

#[tauri::command]
async fn auth_bootstrap(
    app: AppHandle,
    auth: State<'_, AuthState>,
    password: String,
    pin: Option<String>,
) -> Result<AuthSession, String> {
    let (hash, pin_hash) = bounded_spawn_blocking(ExecutionClass::Control, move || {
        let hash = if password.is_empty() { None } else { Some(hash_password(&password)?) };
        let pin_hash = pin
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(hash_pin)
            .transpose()?;
        if hash.is_none() && pin_hash.is_none() { return Err("Задайте пароль или PIN-код".into()); }
        Ok::<_, String>((hash, pin_hash))
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))??;
    let conn = open_db(&app)?;
    let changed = conn
        .execute(
            BOOTSTRAP_CREDENTIALS_SQL,
            params![hash, pin_hash],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Первичная настройка уже выполнена".into());
    }
    let user = user_by_id(&conn, "admin")?.ok_or("Профиль администратора не найден")?;
    insert_audit(
        &app,
        "admin",
        "auth.bootstrap",
        "Настроен способ входа администратора",
    )?;
    new_session(&auth, user)
}

async fn auth_login_internal(
    app: AppHandle,
    auth: State<'_, AuthState>,
    user_id: String,
    credential: String,
    pin_mode: bool,
) -> Result<AuthSession, String> {
    let normalized = user_id.trim().to_lowercase();
    let invalid_message = if pin_mode {
        "Неверное имя пользователя или PIN-код"
    } else {
        "Неверное имя пользователя или пароль"
    };
    if normalized.len() > 64
        || credential.len() > 512
        || (pin_mode && validate_pin(&credential).is_err())
    {
        return Err(invalid_message.into());
    }
    {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Состояние авторизации недоступно")?;
        let now = now_ms();
        inner.failures.retain(|_, failure| {
            failure.locked_until > now
                || now.saturating_sub(failure.last_seen) <= FAILURE_RECORD_TTL_MS
        });
        if now.saturating_sub(inner.global_failures.last_seen) > FAILURE_RECORD_TTL_MS {
            inner.global_failures = FailureRecord::default();
        }
        if inner.global_failures.locked_until > now {
            return Err("Слишком много попыток входа. Повторите через минуту".into());
        }
        if inner
            .failures
            .get(&normalized)
            .is_some_and(|failure| failure.locked_until > now)
        {
            return Err("Слишком много попыток. Повторите вход через несколько минут".into());
        }
    }
    let conn = open_db(&app)?;
    let row: Option<(AppUser, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT id,name,role,enabled,created_at,password_hash,pin_hash FROM users WHERE id=?1",
            params![normalized],
            |row| {
                let pin_hash: Option<String> = row.get(6)?;
                Ok((
                    AppUser {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        role: row.get(2)?,
                        enabled: row.get::<_, i64>(3)? != 0,
                        created_at: row.get(4)?,
                        pin_enabled: pin_hash.as_deref().is_some_and(|value| !value.is_empty()),
                    },
                    row.get(5)?,
                    pin_hash,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    drop(conn);
    let encoded_hash = row.as_ref().and_then(|(_, password_hash, pin_hash)| {
        if pin_mode {
            pin_hash.clone()
        } else {
            password_hash.clone()
        }
    });
    let hash_valid = bounded_spawn_blocking(ExecutionClass::Control, move || {
        match encoded_hash.as_deref() {
            Some(value) if pin_mode => verify_pin(&credential, value),
            Some(value) => verify_password(&credential, value),
            None => {
                let material = if pin_mode {
                    pin_material(&credential)
                } else {
                    credential.as_bytes().to_vec()
                };
                let _ = pbkdf2_sha256(&material, b"KlipperFarmDummy", PASSWORD_ITERATIONS);
                false
            }
        }
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))?;
    let valid = row.as_ref().is_some_and(|(user, _, _)| user.enabled) && hash_valid;
    if !valid {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Состояние авторизации недоступно")?;
        if !inner.failures.contains_key(&normalized) && inner.failures.len() >= MAX_FAILURE_RECORDS {
            if let Some(oldest) = inner
                .failures
                .iter()
                .min_by_key(|(_, failure)| failure.last_seen)
                .map(|(id, _)| id.clone())
            {
                inner.failures.remove(&oldest);
            }
        }
        let failure = inner.failures.entry(normalized.clone()).or_default();
        failure.count = failure.count.saturating_add(1);
        failure.last_seen = now_ms();
        if failure.count >= 5 {
            failure.locked_until = now_ms() + 5 * 60 * 1000;
            failure.count = 0;
        }
        let global = &mut inner.global_failures;
        global.count = global.count.saturating_add(1);
        global.last_seen = now_ms();
        if global.count >= GLOBAL_FAILURE_LIMIT {
            global.locked_until = now_ms() + 60 * 1000;
            global.count = 0;
        }
        drop(inner);
        let _ = insert_audit(
            &app,
            &normalized,
            if pin_mode {
                "auth.pin_failed"
            } else {
                "auth.failed"
            },
            "Неуспешная попытка входа",
        );
        return Err(invalid_message.into());
    }
    auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?
        .failures
        .remove(&normalized);
    let user = row
        .map(|(user, _, _)| user)
        .ok_or_else(|| invalid_message.to_string())?;
    insert_audit(
        &app,
        &user.id,
        if pin_mode {
            "auth.pin_login"
        } else {
            "auth.login"
        },
        if pin_mode {
            "Вход по PIN-коду"
        } else {
            "Вход выполнен"
        },
    )?;
    new_session(&auth, user)
}

#[tauri::command]
async fn auth_login(
    app: AppHandle,
    auth: State<'_, AuthState>,
    user_id: String,
    password: String,
) -> Result<AuthSession, String> {
    auth_login_internal(app, auth, user_id, password, false).await
}

#[tauri::command]
async fn auth_pin_login(
    app: AppHandle,
    auth: State<'_, AuthState>,
    user_id: String,
    pin: String,
) -> Result<AuthSession, String> {
    auth_login_internal(app, auth, user_id, pin, true).await
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelloGrant { version: u8, user_id: String, credential_stamp: String }

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct HelloStatus { available: bool, enrolled: bool, detail: String }

fn hello_entry(id:&str)->Result<keyring::Entry,String>{
    validate_user_id(id)?;
    keyring::Entry::new("KlipperFarm.WindowsHello.v1",id).map_err(|_|"Хранилище доступа Windows недоступно".into())
}
fn hello_grant(id:&str)->Result<Option<HelloGrant>,String>{
    match hello_entry(id)?.get_password(){
        Ok(value) if value.len()<=1024 => serde_json::from_str(&value).map(Some).map_err(|_|"Повторно настройте Windows Hello в настройках входа".into()),
        Ok(_) => Err("Запись Windows Hello повреждена".into()),
        Err(keyring::Error::NoEntry)=>Ok(None),
        Err(_)=>Err("Хранилище доступа Windows недоступно".into()),
    }
}
fn hello_user_stamp(app:&AppHandle,id:&str)->Result<(AppUser,String),String>{
    validate_user_id(id)?;
    let conn=open_db(app)?;
    let user=user_by_id(&conn,id)?.filter(|u|u.enabled).ok_or("Вход для этого пользователя недоступен")?;
    let hashes:(Option<String>,Option<String>)=conn.query_row("SELECT password_hash,pin_hash FROM users WHERE id=?1",params![id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if hashes.0.as_deref().unwrap_or("").is_empty() && hashes.1.as_deref().unwrap_or("").is_empty(){return Err("Сначала настройте пароль или PIN-код".into());}
    let material=serde_json::to_vec(&(&user.id,&user.role,user.created_at,hashes)).map_err(|e|e.to_string())?;
    Ok((user,hex::encode(Sha256::digest(material))))
}
fn hello_grant_matches(grant:&HelloGrant,id:&str,stamp:&str)->bool{
    grant.version==1 && grant.user_id==id && grant.credential_stamp.len()==64 && bool::from(grant.credential_stamp.as_bytes().ct_eq(stamp.as_bytes()))
}
struct HelloBusy(Arc<AtomicBool>);
impl Drop for HelloBusy { fn drop(&mut self){self.0.store(false,Ordering::Release);} }
async fn hello_verify(window:&tauri::WebviewWindow,auth:&State<'_,AuthState>,message:String)->Result<(),String>{
    #[cfg(windows)]
    let hwnd=window.hwnd().map_err(|_|"Окно программы недоступно")?.0 as isize;
    #[cfg(not(windows))]
    let hwnd={let _=window;0isize};
    if auth.hello_busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err("Windows Hello уже ожидает подтверждения".into());}
    let guard=HelloBusy(auth.hello_busy.clone());
    bounded_spawn_blocking(ExecutionClass::Control,move||{let _guard=guard;windows_hello::verify(hwnd,&message)}).await.map_err(|_|"Windows Hello не удалось запустить".to_string())?
}
#[tauri::command]
async fn auth_hello_status(app:AppHandle,user_id:String)->Result<HelloStatus,String>{
    let id=user_id.trim().to_lowercase();validate_user_id(&id)?;
    let available=bounded_spawn_blocking(ExecutionClass::Control,windows_hello::available).await.map_err(|_|"Проверка Windows Hello недоступна")??;
    if !available{return Ok(HelloStatus{available:false,enrolled:false,detail:"Настройте Windows Hello в параметрах входа Windows 11".into()});}
    let enrolled=match (hello_user_stamp(&app,&id),hello_grant(&id)) { (Ok((_,stamp)),Ok(Some(grant)))=>hello_grant_matches(&grant,&id,&stamp),(_,Err(e))=>return Err(e),_=>false };
    Ok(HelloStatus{available:true,enrolled,detail:if enrolled{"Windows Hello подключён"}else{"Войдите по PIN или паролю и включите Windows Hello в настройках"}.into()})
}
#[tauri::command]
async fn auth_hello_enable(app:AppHandle,window:tauri::WebviewWindow,auth:State<'_,AuthState>,session_token:String)->Result<(),String>{
    let user=require_role(&app,&auth,&session_token,Role::Viewer)?;
    let (_,stamp)=hello_user_stamp(&app,&user.id)?;
    hello_verify(&window,&auth,format!("Klipper Farm: подключить Windows Hello для {}",user.name)).await?;
    let current=require_role(&app,&auth,&session_token,Role::Viewer)?;
    let (_,fresh)=hello_user_stamp(&app,&current.id)?;
    if current.id!=user.id || fresh!=stamp {return Err("Доступ изменился. Войдите заново и повторите настройку".into());}
    let record=serde_json::to_string(&HelloGrant{version:1,user_id:user.id.clone(),credential_stamp:stamp}).map_err(|e|e.to_string())?;
    hello_entry(&user.id)?.set_password(&record).map_err(|_|"Не удалось сохранить доступ в Windows".to_string())?;
    insert_audit(&app,&user.id,"auth.hello_enable","Windows Hello подключён на этом ПК")
}
#[tauri::command]
fn auth_hello_disable(app:AppHandle,auth:State<'_,AuthState>,session_token:String)->Result<(),String>{
    let user=require_role(&app,&auth,&session_token,Role::Viewer)?;
    match hello_entry(&user.id)?.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>{},Err(_)=>return Err("Не удалось отключить Windows Hello".into())}
    insert_audit(&app,&user.id,"auth.hello_disable","Windows Hello отключён на этом ПК")
}
#[tauri::command]
async fn auth_hello_login(app:AppHandle,window:tauri::WebviewWindow,auth:State<'_,AuthState>,user_id:String)->Result<AuthSession,String>{
    let id=user_id.trim().to_lowercase();
    let (_,stamp)=hello_user_stamp(&app,&id)?;
    let grant=hello_grant(&id)?.ok_or("Сначала подключите Windows Hello в настройках входа")?;
    if !hello_grant_matches(&grant,&id,&stamp){return Err("Доступ изменился. Войдите по PIN или паролю и подключите Windows Hello заново".into());}
    hello_verify(&window,&auth,"Klipper Farm: подтвердите вход".into()).await?;
    let (user,fresh)=hello_user_stamp(&app,&id)?;
    let current=hello_grant(&id)?.ok_or("Windows Hello отключён во время проверки")?;
    if fresh!=stamp || !hello_grant_matches(&current,&id,&fresh){return Err("Доступ изменился во время проверки. Войдите другим способом".into());}
    insert_audit(&app,&id,"auth.hello_login","Вход подтверждён Windows Hello")?;
    new_session(&auth,user)
}

#[tauri::command]
fn auth_logout(auth: State<'_, AuthState>, session_token: String) -> Result<(), String> {
    auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?
        .sessions
        .remove(&session_token);
    Ok(())
}

#[tauri::command]
async fn auth_change_password(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    let current_hash: Option<String> = {
        let conn = open_db(&app)?;
        conn.query_row(
                "SELECT password_hash FROM users WHERE id=?1",
                params![user.id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?
    };
    let new_hash = bounded_spawn_blocking(ExecutionClass::Control, move || {
        if !current_hash
            .as_deref()
            .is_some_and(|value| verify_password(&current_password, value))
        {
            return Err("Текущий пароль неверен".to_string());
        }
        hash_password(&new_password)
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))??;
    open_db(&app)?.execute(
        "UPDATE users SET password_hash=?1 WHERE id=?2",
        params![new_hash, user.id],
    )
    .map_err(|e| e.to_string())?;
    let mut inner = auth
        .inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?;
    inner
        .sessions
        .retain(|token, record| token == &session_token || record.user_id != user.id);
    drop(inner);
    insert_audit(&app, &user.id, "auth.password_changed", "Пароль изменён")
}

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

fn db_write_role(key: &str) -> Result<Role, String> {
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
fn db_get_json(
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
fn db_set_json(
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
fn audit_add(
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

fn notification_action_allowed(action: &str) -> bool {
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
fn audit_list(
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
fn notification_list(
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
fn users_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
) -> Result<Vec<AppUser>, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    users_list_internal(&open_db(&app)?)
}

fn validate_user_id(id: &str) -> Result<(), String> {
    if !(3..=64).contains(&id.len())
        || !id.bytes().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || b"._-".contains(&value)
        })
    {
        return Err("ID пользователя: 3–64 символа a-z, 0-9, '.', '_' или '-'".into());
    }
    Ok(())
}

fn ensure_pin_removal_keeps_access(conn:&Connection,id:&str,clear_pin:bool,new_password:bool)->Result<(),String>{
    if clear_pin && !new_password {
        let has_password:bool=conn.query_row("SELECT COALESCE(password_hash,'')!='' FROM users WHERE id=?1",params![id],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !has_password {return Err("Сначала задайте пароль: нельзя удалить единственный способ входа".into());}
    }
    Ok(())
}

#[tauri::command]
async fn user_save(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    user: UserInput,
) -> Result<(), String> {
    let actor = require_role(&app, &auth, &session_token, Role::Admin)?;
    let id = user.id.trim().to_lowercase();
    validate_user_id(&id)?;
    let role = parse_role(&user.role)?;
    let name = user.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Имя пользователя должно содержать от 1 до 80 символов".into());
    }
    if id == "admin" && (role != Role::Admin || !user.enabled) {
        return Err("Встроенного администратора нельзя отключить или понизить".into());
    }
    let previous: Option<(String, bool)> = {
        let conn = open_db(&app)?;
        conn.query_row(
                "SELECT role,enabled FROM users WHERE id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(|e| e.to_string())?
    };
    let exists = previous.is_some();
    if user.clear_pin && user.pin.as_deref().is_some_and(|value| !value.is_empty()) {
        return Err("Нельзя одновременно задать и удалить PIN-код".into());
    }
    if !exists && !user.password.as_deref().is_some_and(|value| !value.is_empty()) && !user.pin.as_deref().is_some_and(|value| !value.is_empty()) {
        return Err("Для нового пользователя требуется пароль или PIN-код".into());
    }
    let password = user.password.clone();
    let pin = user.pin.clone();
    let (password_hash, pin_hash) = bounded_spawn_blocking(ExecutionClass::Control, move || {
        let password_hash = password
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(hash_password)
            .transpose()?;
        let pin_hash = pin
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(hash_pin)
            .transpose()?;
        Ok::<_, String>((password_hash, pin_hash))
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))??;
    let access_changed = previous
        .as_ref()
        .is_some_and(|(old_role, old_enabled)| old_role != &user.role || *old_enabled != user.enabled);
    let credentials_changed = password_hash.is_some() || user.clear_pin || pin_hash.is_some();
    let mut conn = open_db(&app)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    if exists { ensure_pin_removal_keeps_access(&transaction,&id,user.clear_pin,password_hash.is_some())?; }
    if exists {
        transaction
            .execute(
                "UPDATE users SET
                     name=?1,role=?2,enabled=?3,
                     password_hash=COALESCE(?4,password_hash),
                     pin_hash=CASE WHEN ?5=1 THEN NULL ELSE COALESCE(?6,pin_hash) END
                 WHERE id=?7",
                params![
                    name,
                    &user.role,
                    if user.enabled { 1 } else { 0 },
                    password_hash.as_deref(),
                    if user.clear_pin { 1 } else { 0 },
                    pin_hash.as_deref(),
                    &id
                ],
            )
            .map_err(|e| e.to_string())?;
    } else {
        transaction
            .execute(
                "INSERT INTO users(id,name,role,enabled,created_at,password_hash,pin_hash) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![&id, name, &user.role, if user.enabled { 1 } else { 0 }, user.created_at.max(1), password_hash.as_deref(), pin_hash.as_deref()],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    if exists && (access_changed || credentials_changed) {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Состояние авторизации недоступно")?;
        revoke_user_sessions(&mut inner, &id);
    }
    insert_audit(
        &app,
        &actor.id,
        if exists { "user.update" } else { "user.create" },
        &id,
    )
}

fn revoke_user_sessions(inner: &mut AuthInner, user_id: &str) {
    inner
        .sessions
        .retain(|_, record| record.user_id != user_id);
}

#[tauri::command]
fn user_delete(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    id: String,
) -> Result<(), String> {
    let actor = require_role(&app, &auth, &session_token, Role::Admin)?;
    let id = id.trim().to_lowercase();
    if id == "admin" || id == actor.id {
        return Err("Нельзя удалить встроенного или текущего пользователя".into());
    }
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM users WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    let mut inner = auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?;
    revoke_user_sessions(&mut inner, &id);
    drop(inner);
    insert_audit(&app, &actor.id, "user.delete", &id)
}

#[tauri::command]
fn db_backup_json(
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
fn db_restore_json(
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

fn rpc_required_role(method: &str, params: Option<&serde_json::Value>) -> Result<Role, String> {
    match method {
        "server.info"
        | "printer.info"
        | "machine.system_info"
        | "printer.objects.list"
        | "printer.objects.query"
        | "server.files.list" => Ok(Role::Viewer),
        "server.spoolman.proxy" => {
            let request_method = params
                .and_then(|value| value.get("request_method"))
                .and_then(|value| value.as_str());
            let path = params
                .and_then(|value| value.get("path"))
                .and_then(|value| value.as_str());
            if request_method == Some("GET")
                && path.is_some_and(|value| value.starts_with("/v1/spool"))
            {
                Ok(Role::Viewer)
            } else {
                Err("Метод Spoolman заблокирован политикой безопасности".into())
            }
        }
        "printer.print.pause"
        | "printer.print.resume"
        | "printer.print.cancel"
        | "printer.print.start"
        | "printer.emergency_stop"
        | "printer.restart"
        | "printer.firmware_restart"
        | "printer.gcode.script"
        | "server.job_queue.post_job"
        | "server.job_queue.start"
        | "server.job_queue.pause"
        | "server.job_queue.delete_job"
        | "server.spoolman.post_spool_id" => Ok(Role::Operator),
        _ => Err("Метод Moonraker не разрешён политикой безопасности".into()),
    }
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

#[derive(Debug, PartialEq, Eq)]
struct RestRpcFallback {
    method: &'static str,
    path: String,
    content_type: Option<&'static str>,
    body: Vec<u8>,
}

fn rpc_params_body(params: Option<&serde_json::Value>) -> Result<Vec<u8>, String> {
    let value = params
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if body.len() > 512 * 1024 {
        return Err("Параметры Moonraker слишком велики".into());
    }
    Ok(body)
}

fn rpc_without_params(
    method: &str,
    path: &'static str,
    http_method: &'static str,
    params: Option<&serde_json::Value>,
) -> Result<Option<RestRpcFallback>, String> {
    if params.is_some_and(|value| !value.is_null()) {
        return Err(format!("Метод {method} не принимает параметры"));
    }
    Ok(Some(RestRpcFallback {
        method: http_method,
        path: path.to_string(),
        content_type: None,
        body: Vec::new(),
    }))
}

fn queue_delete_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let params = params
        .and_then(|value| value.as_object())
        .ok_or("Для удаления из очереди нужны параметры")?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if params.get("all").and_then(|value| value.as_bool()) == Some(true) {
        query.append_pair("all", "true");
    } else {
        let job_ids = params
            .get("job_ids")
            .and_then(|value| value.as_array())
            .ok_or("Для удаления из очереди нужны job_ids")?;
        if job_ids.is_empty() || job_ids.len() > 256 {
            return Err("Некорректное количество job_ids".into());
        }
        let mut values = Vec::with_capacity(job_ids.len());
        for value in job_ids {
            let id = value
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
                .ok_or("Некорректный job_id")?;
            values.push(id);
        }
        query.append_pair("job_ids", &values.join(","));
    }
    Ok(RestRpcFallback {
        method: "DELETE",
        path: format!("/server/job_queue/job?{}", query.finish()),
        content_type: None,
        body: Vec::new(),
    })
}

fn files_list_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let mut path = "/server/files/list".to_string();
    if let Some(value) = params.filter(|value| !value.is_null()) {
        let object = value
            .as_object()
            .ok_or("Некорректные параметры списка файлов")?;
        if object.keys().any(|key| key != "root") {
            return Err("Неподдерживаемые параметры списка файлов".into());
        }
        if let Some(root) = object.get("root") {
            let root = root
                .as_str()
                .filter(|root| matches!(*root, "gcodes" | "config"))
                .ok_or("Недопустимый корень списка файлов")?;
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.append_pair("root", root);
            let query = serializer.finish();
            path.push('?');
            path.push_str(&query);
        }
    }
    Ok(RestRpcFallback {
        method: "GET",
        path,
        content_type: None,
        body: Vec::new(),
    })
}

fn files_move_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let object = params
        .and_then(serde_json::Value::as_object)
        .ok_or("Для перемещения нужны source и dest")?;
    if object.keys().any(|key| !matches!(key.as_str(), "source" | "dest")) {
        return Err("Неподдерживаемые параметры перемещения файла".into());
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for field in ["source", "dest"] {
        let value = object.get(field).and_then(serde_json::Value::as_str)
            .filter(|value| {
                !value.is_empty() && value.len() <= 2048
                    && !value.bytes().any(|byte| byte < 0x20 || byte == 0x7f || byte == b'\\')
                    && value.split('/').count() >= 2
                    && matches!(value.split('/').next(), Some("gcodes" | "config"))
                    && !value.split('/').any(|part| part.is_empty() || matches!(part, "." | ".."))
            })
            .ok_or_else(|| format!("Некорректный путь перемещения: {field}"))?;
        query.append_pair(field, value);
    }
    // Query arguments work with stock Moonraker and vendor REST handlers that
    // do not expose /server/jsonrpc or decode JSON bodies for file operations.
    Ok(RestRpcFallback {
        method: "POST",
        path: format!("/server/files/move?{}", query.finish()),
        content_type: None,
        body: Vec::new(),
    })
}

fn objects_query_get_fallback(
    params: Option<&serde_json::Value>,
) -> Result<RestRpcFallback, String> {
    let params = params
        .and_then(|value| value.as_object())
        .ok_or("Для запроса объектов нужны параметры")?;
    if params.keys().any(|key| key != "objects") {
        return Err("Неподдерживаемые параметры запроса объектов".into());
    }
    let objects = params
        .get("objects")
        .and_then(|value| value.as_object())
        .filter(|objects| !objects.is_empty() && objects.len() <= 512)
        .ok_or("Некорректный список объектов Moonraker")?;
    let encode = |value: &str| -> String {
        url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
    };
    let mut parts = Vec::with_capacity(objects.len());
    for (name, fields) in objects {
        if name.is_empty() || name.len() > 160 || name.chars().any(char::is_control) {
            return Err("Некорректное имя объекта Moonraker".into());
        }
        let encoded_name = encode(name);
        if fields.is_null() {
            parts.push(encoded_name);
            continue;
        }
        let fields = fields
            .as_array()
            .filter(|fields| fields.len() <= 64)
            .ok_or("Некорректный список полей объекта Moonraker")?;
        let mut names = Vec::with_capacity(fields.len());
        for field in fields {
            let field = field
                .as_str()
                .filter(|field| {
                    !field.is_empty()
                        && field.len() <= 96
                        && field.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                        })
                })
                .ok_or("Некорректное поле объекта Moonraker")?;
            names.push(field);
        }
        parts.push(format!("{encoded_name}={}", encode(&names.join(","))));
    }
    let path = format!("/printer/objects/query?{}", parts.join("&"));
    if path.len() > 4096 {
        return Err("Запрос объектов Moonraker слишком велик".into());
    }
    Ok(RestRpcFallback {
        method: "GET",
        path,
        content_type: None,
        body: Vec::new(),
    })
}

fn print_start_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let object = params
        .and_then(|value| value.as_object())
        .ok_or("Для запуска печати требуется имя файла")?;
    if object.keys().any(|key| key != "filename") {
        return Err("Неподдерживаемые параметры запуска печати".into());
    }
    let filename = object
        .get("filename")
        .and_then(|value| value.as_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 2048
                && !value.starts_with('/')
                && !value
                    .bytes()
                    .any(|byte| byte < 0x20 || byte == 0x7f || byte == b'\\')
                && !value
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | ".."))
        })
        .ok_or("Некорректное имя файла печати")?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("filename", filename);
    Ok(RestRpcFallback {
        method: "POST",
        path: format!("/printer/print/start?{}", serializer.finish()),
        content_type: None,
        body: Vec::new(),
    })
}

fn rest_fallback_for_rpc(
    method: &str,
    params: Option<&serde_json::Value>,
) -> Result<Option<RestRpcFallback>, String> {
    let json_post = |path: &'static str| -> Result<Option<RestRpcFallback>, String> {
        Ok(Some(RestRpcFallback {
            method: "POST",
            path: path.to_string(),
            content_type: Some("application/json"),
            body: rpc_params_body(params)?,
        }))
    };
    match method {
        "server.info" => rpc_without_params(method, "/server/info", "GET", params),
        "printer.info" => rpc_without_params(method, "/printer/info", "GET", params),
        "machine.system_info" => rpc_without_params(method, "/machine/system_info", "GET", params),
        "printer.objects.list" => {
            rpc_without_params(method, "/printer/objects/list", "GET", params)
        }
        "printer.objects.query" => json_post("/printer/objects/query"),
        "server.files.list" => Ok(Some(files_list_fallback(params)?)),
        "server.files.move" => Ok(Some(files_move_fallback(params)?)),
        "server.spoolman.proxy" => json_post("/server/spoolman/proxy"),
        "printer.print.pause" => rpc_without_params(method, "/printer/print/pause", "POST", params),
        "printer.print.resume" => {
            rpc_without_params(method, "/printer/print/resume", "POST", params)
        }
        "printer.print.cancel" => {
            rpc_without_params(method, "/printer/print/cancel", "POST", params)
        }
        "printer.print.start" => Ok(Some(print_start_fallback(params)?)),
        "printer.emergency_stop" => {
            rpc_without_params(method, "/printer/emergency_stop", "POST", params)
        }
        "printer.restart" => rpc_without_params(method, "/printer/restart", "POST", params),
        "printer.firmware_restart" => {
            rpc_without_params(method, "/printer/firmware_restart", "POST", params)
        }
        "printer.gcode.script" => json_post("/printer/gcode/script"),
        "server.job_queue.post_job" => json_post("/server/job_queue/job"),
        "server.job_queue.start" => {
            rpc_without_params(method, "/server/job_queue/start", "POST", params)
        }
        "server.job_queue.pause" => {
            rpc_without_params(method, "/server/job_queue/pause", "POST", params)
        }
        "server.job_queue.delete_job" => Ok(Some(queue_delete_fallback(params)?)),
        "server.spoolman.post_spool_id" => json_post("/server/spoolman/spool_id"),
        _ => Ok(None),
    }
}

fn parse_moonraker_result(response: HttpResponse) -> Result<serde_json::Value, String> {
    if !(200..300).contains(&response.status) {
        return Err(format!("Moonraker HTTP error: {}", response.status));
    }
    if response.body.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let json: serde_json::Value =
        serde_json::from_slice(&response.body).map_err(|e| format!("Moonraker JSON error: {e}"))?;
    Ok(json.get("result").cloned().unwrap_or(json))
}

fn moonraker_query_result_useful(value: &serde_json::Value) -> bool {
    let mut queue = vec![value];
    let mut inspected = 0usize;
    while let Some(current) = queue.pop() {
        inspected += 1;
        if inspected > 16 {
            break;
        }
        let Some(object) = current.as_object() else {
            continue;
        };
        if object
            .get("status")
            .and_then(|status| status.as_object())
            .is_some_and(|status| !status.is_empty())
        {
            return true;
        }
        if object.keys().any(|key| {
            matches!(
                key.as_str(),
                "print_stats"
                    | "virtual_sdcard"
                    | "extruder"
                    | "heater_bed"
                    | "webhooks"
                    | "toolhead"
                    | "configfile"
            )
        }) {
            return true;
        }
        for key in ["result", "data", "response"] {
            if let Some(child) = object.get(key) {
                queue.push(child);
            }
        }
    }
    false
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

#[cfg(test)]
fn execute_rest_rpc_fallback(
    target: &HttpTarget,
    api_key: Option<&str>,
    method: &str,
    params: Option<&serde_json::Value>,
    timeout: Duration,
    query_get_first: bool,
) -> Result<Option<serde_json::Value>, String> {
    let preferred_query_get = query_get_first && method == "printer.objects.query";
    let fallback = if preferred_query_get {
        Some(objects_query_get_fallback(params)?)
    } else {
        rest_fallback_for_rpc(method, params)?
    };
    let Some(fallback) = fallback else {
        return Ok(None);
    };
    let response = http_request(
        target,
        fallback.method,
        &fallback.path,
        api_key,
        fallback.content_type,
        &fallback.body,
        MAX_JSON_RESPONSE,
        timeout,
    )?;
    // POST is the current Moonraker REST API. Some FlashForge/community forks
    // expose the older query-string GET form only, so retry that exact bounded
    // read request after an explicit endpoint/method miss.
    let mut used_query_get = preferred_query_get;
    let response = if method == "printer.objects.query"
        && used_query_get
        && matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)
    {
        used_query_get = false;
        let alternate = rest_fallback_for_rpc(method, params)?
            .ok_or("REST POST endpoint Moonraker недоступен")?;
        http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?
    } else if method == "printer.objects.query"
        && !used_query_get
        && matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)
    {
        used_query_get = true;
        let alternate = objects_query_get_fallback(params)?;
        http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?
    } else {
        response
    };
    let result = parse_moonraker_result(response)?;
    if method == "printer.objects.query"
        && used_query_get
        && preferred_query_get
        && !moonraker_query_result_useful(&result)
    {
        let alternate = rest_fallback_for_rpc(method, params)?
            .ok_or("REST POST endpoint Moonraker недоступен")?;
        let response = http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?;
        return parse_moonraker_result(response).map(Some);
    }
    if method == "printer.objects.query"
        && !used_query_get
        && !preferred_query_get
        && !moonraker_query_result_useful(&result)
    {
        let alternate = objects_query_get_fallback(params)?;
        let response = http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?;
        return parse_moonraker_result(response).map(Some);
    }
    Ok(Some(result))
}

async fn execute_rest_rpc_fallback_async(
    target: &HttpTarget,
    api_key: Option<&str>,
    method: &str,
    params: Option<&serde_json::Value>,
    deadline: tokio::time::Instant,
    query_get_first: bool,
    cancellation: &kf_moonraker::CancellationToken,
) -> Result<Option<serde_json::Value>, String> {
    let preferred_query_get = query_get_first && method == "printer.objects.query";
    let fallback = if preferred_query_get {
        Some(objects_query_get_fallback(params)?)
    } else {
        rest_fallback_for_rpc(method, params)?
    };
    let Some(mut fallback) = fallback else {
        return Ok(None);
    };
    let mut used_query_get = preferred_query_get;
    let mut remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("OPERATION_DEADLINE_EXCEEDED".into());
    }
    let mut response = moonraker_protocol::http_request_async(
        target,
        fallback.method,
        &fallback.path,
        api_key,
        fallback.content_type,
        &fallback.body,
        MAX_JSON_RESPONSE,
        remaining,
        cancellation,
    )
    .await?;
    if method == "printer.objects.query"
        && matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)
    {
        fallback = if used_query_get {
            rest_fallback_for_rpc(method, params)?
                .ok_or("REST POST endpoint Moonraker недоступен")?
        } else {
            objects_query_get_fallback(params)?
        };
        used_query_get = !used_query_get;
        remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("OPERATION_DEADLINE_EXCEEDED".into());
        }
        response = moonraker_protocol::http_request_async(
            target,
            fallback.method,
            &fallback.path,
            api_key,
            fallback.content_type,
            &fallback.body,
            MAX_JSON_RESPONSE,
            remaining,
            cancellation,
        )
        .await?;
    }
    let result = parse_moonraker_result(response)?;
    let compatibility_empty = method == "printer.objects.query"
        && !moonraker_query_result_useful(&result)
        && ((used_query_get && preferred_query_get) || (!used_query_get && !preferred_query_get));
    if compatibility_empty {
        fallback = if used_query_get {
            rest_fallback_for_rpc(method, params)?
                .ok_or("REST POST endpoint Moonraker недоступен")?
        } else {
            objects_query_get_fallback(params)?
        };
        remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("OPERATION_DEADLINE_EXCEEDED".into());
        }
        let response = moonraker_protocol::http_request_async(
            target,
            fallback.method,
            &fallback.path,
            api_key,
            fallback.content_type,
            &fallback.body,
            MAX_JSON_RESPONSE,
            remaining,
            cancellation,
        )
        .await?;
        return parse_moonraker_result(response).map(Some);
    }
    Ok(Some(result))
}

fn should_try_rest_fallback(status: u16, rpc_error_code: Option<i64>) -> bool {
    matches!(status, 404 | 405) || rpc_error_code == Some(-32601)
}

fn should_try_query_compatibility_fallback(
    method: &str,
    status: u16,
    rpc_error_code: Option<i64>,
) -> bool {
    method == "printer.objects.query"
        && (matches!(status, 400 | 415 | 422 | 500 | 501) || rpc_error_code == Some(-32602))
}

fn bounded_rpc_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(8_000).clamp(1_000, 8_000))
}

fn bounded_http_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1_000, 15_000))
}

#[cfg(test)]
fn rpc_blocking(
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    prefer_rest: bool,
    timeout_ms: Option<u64>,
    default_port: u16,
) -> Result<serde_json::Value, String> {
    let target = parse_target(&host, default_port)?;
    let timeout = bounded_rpc_timeout(timeout_ms);
    // Selected vendor profiles may opt into the fixed, allowlisted REST route.
    // This mode is deliberately strict: after a REST network timeout we must
    // not start a second full JSON-RPC timeout, otherwise a 3.5 s K1C cycle
    // becomes the 8-9 s UI stall this path is intended to prevent.
    if prefer_rest {
        let result = execute_rest_rpc_fallback(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            timeout,
            true,
        )?
        .ok_or("REST endpoint Moonraker не поддерживает этот метод")?;
        if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
            return Err("REST Moonraker вернул пустой снимок объектов".into());
        }
        return Ok(result);
    }
    let mut request = serde_json::json!({"jsonrpc":"2.0","method":&method,"id":1});
    if let Some(value) = params.as_ref() {
        if !value.is_null() {
            request["params"] = value.clone();
        }
    }
    let body = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if body.len() > 512 * 1024 {
        return Err("Параметры Moonraker слишком велики".into());
    }
    let response = http_request(
        &target,
        "POST",
        "/server/jsonrpc",
        api_key.as_deref(),
        Some("application/json"),
        &body,
        MAX_JSON_RESPONSE,
        timeout,
    )?;
    if should_try_rest_fallback(response.status, None)
        || should_try_query_compatibility_fallback(&method, response.status, None)
    {
        if let Some(result) = execute_rest_rpc_fallback(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            timeout,
            false,
        )? {
            return Ok(result);
        }
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("Moonraker HTTP error: {}", response.status));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&response.body).map_err(|e| format!("Moonraker JSON error: {e}"))?;
    if let Some(error) = json.get("error") {
        let rpc_error_code = error.get("code").and_then(|value| value.as_i64());
        if should_try_rest_fallback(response.status, rpc_error_code)
            || should_try_query_compatibility_fallback(&method, response.status, rpc_error_code)
        {
            if let Some(result) = execute_rest_rpc_fallback(
                &target,
                api_key.as_deref(),
                &method,
                params.as_ref(),
                timeout,
                false,
            )? {
                return Ok(result);
            }
        }
        let message: String = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Moonraker RPC error")
            .chars()
            .take(512)
            .collect();
        return Err(format!("MOONRAKER_RPC: {message}"));
    }
    let result = json.get("result").cloned().unwrap_or(json);
    if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
        if let Some(compatible) = execute_rest_rpc_fallback(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            timeout,
            false,
        )? {
            return Ok(compatible);
        }
    }
    Ok(result)
}

async fn rpc_async(
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    prefer_rest: bool,
    timeout_ms: Option<u64>,
    default_port: u16,
    cancellation: kf_moonraker::CancellationToken,
) -> Result<serde_json::Value, String> {
    let target = parse_target(&host, default_port)?;
    let deadline = tokio::time::Instant::now() + bounded_rpc_timeout(timeout_ms);
    if prefer_rest {
        let result = execute_rest_rpc_fallback_async(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            deadline,
            true,
            &cancellation,
        )
        .await?
        .ok_or("REST endpoint Moonraker не поддерживает этот метод")?;
        if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
            return Err("REST Moonraker вернул пустой снимок объектов".into());
        }
        return Ok(result);
    }

    let mut request = serde_json::json!({"jsonrpc":"2.0","method":&method,"id":1});
    if let Some(value) = params.as_ref().filter(|value| !value.is_null()) {
        request["params"] = value.clone();
    }
    let body = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    if body.len() > 512 * 1024 {
        return Err("Параметры Moonraker слишком велики".into());
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("OPERATION_DEADLINE_EXCEEDED".into());
    }
    let response = moonraker_protocol::http_request_async(
        &target,
        "POST",
        "/server/jsonrpc",
        api_key.as_deref(),
        Some("application/json"),
        &body,
        MAX_JSON_RESPONSE,
        remaining,
        &cancellation,
    )
    .await?;
    if should_try_rest_fallback(response.status, None)
        || should_try_query_compatibility_fallback(&method, response.status, None)
    {
        if let Some(result) = execute_rest_rpc_fallback_async(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            deadline,
            false,
            &cancellation,
        )
        .await?
        {
            return Ok(result);
        }
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("Moonraker HTTP error: {}", response.status));
    }
    let json: serde_json::Value = serde_json::from_slice(&response.body)
        .map_err(|error| format!("Moonraker JSON error: {error}"))?;
    if let Some(error) = json.get("error") {
        let rpc_error_code = error.get("code").and_then(serde_json::Value::as_i64);
        if should_try_rest_fallback(response.status, rpc_error_code)
            || should_try_query_compatibility_fallback(&method, response.status, rpc_error_code)
        {
            if let Some(result) = execute_rest_rpc_fallback_async(
                &target,
                api_key.as_deref(),
                &method,
                params.as_ref(),
                deadline,
                false,
                &cancellation,
            )
            .await?
            {
                return Ok(result);
            }
        }
        let message: String = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Moonraker RPC error")
            .chars()
            .take(512)
            .collect();
        return Err(format!("MOONRAKER_RPC: {message}"));
    }
    let result = json.get("result").cloned().unwrap_or(json);
    if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
        if let Some(compatible) = execute_rest_rpc_fallback_async(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            deadline,
            false,
            &cancellation,
        )
        .await?
        {
            return Ok(compatible);
        }
    }
    Ok(result)
}

#[tauri::command]
async fn moonraker_rpc(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, engine_client::EngineClient>,
    session_token: String,
    printer_id: Option<String>,
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    prefer_rest: Option<bool>,
    timeout_ms: Option<u64>,
    default_port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let minimum = rpc_required_role(&method, params.as_ref())?;
    let user = require_role(&app, &auth, &session_token, minimum)?;
    let printer_id = printer_id.ok_or("Отсутствует ID принтера")?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if api_key.is_some() && parse_role(&user.role)? < Role::Admin {
        return Err("FORBIDDEN: только администратор может передавать новый API Key".into());
    }
    let key = match api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(value.trim().to_string()),
        None => stored_api_key(Some(&printer_id))?,
    };
    if let Some(value) = key.as_deref() {
        validate_header_value(value, 512)?;
    }
    let default_port = moonraker_default_port(default_port)?;
    let discovery_probe = printer_id.starts_with("scan-");
    if !discovery_probe && client.route_to_daemon().await? {
        let result: transactional_core::types::OperationResult = client
            .call_async(
                ExecutionClass::ActorIo,
                kf_ipc::EngineCommand::ActorRpc,
                serde_json::json!({
                    "printerId":printer_id,
                    "method":method,
                    "params":params,
                    "preferRest":prefer_rest.unwrap_or(false),
                    "timeoutMs":timeout_ms,
                    "expectedSessionEpoch":null,
                    "operationId":null,
                }),
            )
            .await?;
        return Ok(result.result);
    }
    let embedded_ready = match core.initialize(&app) {
        Ok(()) => true,
        Err(error) if engine_owner_conflict(&error) => {
            // A stale or independently managed daemon can still own the
            // process-wide engine lease while its IPC endpoint is unusable.
            // The authenticated, target-authorized direct Moonraker transport
            // does not touch SQLite or actor state, so keep printer telemetry
            // available instead of turning one local IPC fault into a 0/N
            // farm outage.
            crate::observability::record(
                "warn",
                "desktop_startup",
                "MOONRAKER_DIRECT_FAILOVER",
                Some(&printer_id),
                "Engine lease занят без доступного IPC; запрос отправлен напрямую в Moonraker",
                serde_json::json!({"engineError":error,"method":method}),
            );
            false
        }
        Err(error) => return Err(error),
    };
    if embedded_ready && core.snapshot_for_printer(&printer_id).is_some() {
        let core = core.inner().clone();
        return bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
            core.execute_by_printer_id(
                &printer_id,
                method,
                params,
                prefer_rest.unwrap_or(false),
                timeout_ms.unwrap_or(8_000),
                None,
                None,
                None,
                None,
            )?
            .map(|result| result.result)
            .ok_or_else(|| "PrinterActor остановлен во время отправки команды".into())
        })
        .await
        .map_err(|error| format!("PrinterActor RPC worker failed: {error}"))?;
    }
    rpc_async(
        host,
        key,
        method,
        params,
        prefer_rest.unwrap_or(false),
        timeout_ms,
        default_port,
        kf_moonraker::CancellationToken::default(),
    )
    .await
}

#[tauri::command]
async fn moonraker_ws_rpc(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, engine_client::EngineClient>,
    session_token: String,
    printer_id: Option<String>,
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
    default_port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let minimum = rpc_required_role(&method, params.as_ref())?;
    let user = require_role(&app, &auth, &session_token, minimum)?;
    let printer_id = printer_id.ok_or("Отсутствует ID принтера")?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if api_key.is_some() && parse_role(&user.role)? < Role::Admin {
        return Err("FORBIDDEN: только администратор может передавать новый API Key".into());
    }
    let key = match api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(value.trim().to_string()),
        None => stored_api_key(Some(&printer_id))?,
    };
    if let Some(value) = key.as_deref() {
        validate_header_value(value, 512)?;
    }
    let default_port = moonraker_default_port(default_port)?;
    let discovery_probe = printer_id.starts_with("scan-");
    if !discovery_probe && client.route_to_daemon().await? {
        let result: transactional_core::types::OperationResult = client
            .call_async(
                ExecutionClass::ActorIo,
                kf_ipc::EngineCommand::ActorRpc,
                serde_json::json!({
                    "printerId":printer_id,
                    "method":method,
                    "params":params,
                    "preferRest":false,
                    "timeoutMs":timeout_ms,
                    "expectedSessionEpoch":null,
                    "operationId":null,
                }),
            )
            .await?;
        return Ok(result.result);
    }
    let embedded_ready = match core.initialize(&app) {
        Ok(()) => true,
        Err(error) if engine_owner_conflict(&error) => {
            crate::observability::record(
                "warn",
                "desktop_startup",
                "MOONRAKER_DIRECT_FAILOVER",
                Some(&printer_id),
                "Engine lease занят без доступного IPC; WebSocket-запрос отправлен напрямую в Moonraker",
                serde_json::json!({"engineError":error,"method":method}),
            );
            false
        }
        Err(error) => return Err(error),
    };
    if embedded_ready && core.snapshot_for_printer(&printer_id).is_some() {
        let core = core.inner().clone();
        return bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
            core.execute_by_printer_id(
                &printer_id,
                method,
                params,
                false,
                timeout_ms.unwrap_or(8_000),
                None,
                None,
                None,
                None,
            )?
            .map(|result| result.result)
            .ok_or_else(|| "PrinterActor остановлен во время отправки команды".into())
        })
        .await
        .map_err(|error| format!("PrinterActor WebSocket worker failed: {error}"))?;
    }
    bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
        websocket_rpc_blocking(host, key, method, params, timeout_ms, default_port)
    })
    .await
    .map_err(|error| format!("Moonraker WebSocket worker failed: {error}"))?
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
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("print-snapshots");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let smoke_requested = desktop_startup::smoke_requested();
    desktop_startup::set_smoke_mode(smoke_requested);
    desktop_startup::install_panic_hook();
    desktop_startup::record(
        "DESKTOP_PROCESS_STARTED",
        &desktop_startup::process_identity(),
    );
    let smoke = match desktop_startup::DesktopSmoke::from_process_args() {
        Ok(smoke) => smoke,
        Err(error) => {
            desktop_startup::report_failure("DESKTOP_ARGUMENT_VALIDATION_FAILED", &error);
            return;
        }
    };
    // Decide ownership before Tauri creates a second visible login window.
    // Waiting here cannot block the primary process's WebView event loop.
    let lease = if smoke.is_none() {
        match InstanceLease::acquire() {
            Ok(lease) => Some(lease),
            Err(error) if error == "INSTANCE_ALREADY_RUNNING" => {
                desktop_startup::record(
                    "SECONDARY_INSTANCE_FOCUS_REQUESTED",
                    "existing desktop acknowledged the focus request",
                );
                return;
            }
            Err(error) => {
                desktop_startup::report_failure("DESKTOP_INSTANCE_LEASE_FAILED", &error);
                return;
            }
        }
    } else {
        None
    };
    if let Err(error) = run_desktop(smoke, lease) {
        desktop_startup::report_failure("TAURI_DESKTOP_RUN_FAILED", &error);
    }
}

fn run_desktop(
    smoke: Option<desktop_startup::DesktopSmoke>,
    lease: Option<InstanceLease>,
) -> Result<(), String> {
    let smoke_for_setup = smoke.clone();
    let smoke_for_page_load = smoke;
    let result = tauri::Builder::default()
        .manage(AuthState::default())
        .manage(online_updates::UpdateState::default())
        .manage(DiscoveryState::default())
        .manage(UploadState::default())
        .manage(LocalTransferState::default())
        .manage(TransactionalCore::default())
        .manage(engine_client::EngineClient::default())
        .manage(TransactionalUploadState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .on_page_load(move |webview, payload| {
            if webview.label() != "main"
                || !matches!(
                    payload.event(),
                    tauri::webview::PageLoadEvent::Finished
                )
            {
                return;
            }
            desktop_startup::mark_window_ready(payload.url().as_str());
            if let Some(smoke) = smoke_for_page_load.as_ref() {
                let exit_code = match desktop_startup::write_smoke_marker(
                    smoke,
                    webview.label(),
                    payload.url().as_str(),
                ) {
                    Ok(()) => 0,
                    Err(error) => {
                        desktop_startup::record("DESKTOP_SMOKE_MARKER_FAILED", &error);
                        72
                    }
                };
                webview.app_handle().exit(exit_code);
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("MAIN_TAURI_WINDOW_NOT_CREATED"))?;
            window.show()?;
            window.unminimize()?;
            if let Err(error) = window.set_focus() {
                desktop_startup::record("MAIN_WINDOW_FOCUS_FAILED", &error.to_string());
            }
            if !window.is_visible()? {
                return Err(std::io::Error::other("MAIN_TAURI_WINDOW_NOT_VISIBLE").into());
            }
            desktop_startup::record("MAIN_TAURI_WINDOW_SHOWN", "window=main visible=true");

            if smoke_for_setup.is_none() {
                let lease = lease.ok_or_else(|| {
                    std::io::Error::other("DESKTOP_INSTANCE_LEASE_MISSING")
                })?;
                if let Err(error) = lease.start_focus_listener(
                    handle.clone(),
                    app.state::<AuthState>().hello_busy.clone(),
                ) {
                    desktop_startup::report_failure("FOCUS_LISTENER_START_FAILED", &error);
                    handle.exit(73);
                    return Ok(());
                }
                if !app.manage(lease) {
                    desktop_startup::report_failure(
                        "DESKTOP_INSTANCE_LEASE_DUPLICATED",
                        "Tauri state already contains InstanceLease",
                    );
                    handle.exit(73);
                    return Ok(());
                }
                if let Err(error) = database::initialize_app_database(&handle) {
                    desktop_startup::report_failure("DESKTOP_DATABASE_INIT_FAILED", &error);
                    handle.exit(73);
                    return Ok(());
                }
                engine_client::EngineClient::initialize_background(handle.clone());
                online_updates::cleanup_background(handle.clone());
            }

            let watchdog_handle = handle;
            if let Err(error) = thread::Builder::new()
                .name("klipper-farm-desktop-startup-watchdog".into())
                .spawn(move || {
                    thread::sleep(Duration::from_secs(30));
                    if !desktop_startup::window_ready() {
                        desktop_startup::report_failure(
                            "DESKTOP_WINDOW_READY_TIMEOUT",
                            "Tauri created the process but the main WebView did not finish loading in 30 seconds",
                        );
                        watchdog_handle.exit(74);
                    }
                })
            {
                desktop_startup::report_failure(
                    "DESKTOP_STARTUP_WATCHDOG_FAILED",
                    &error.to_string(),
                );
                app.handle().exit(73);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            offline_voice::voice_tools_status,
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
            update_status,
            update_cancel,
            update_apply,
            update_check,
            update_install,
            update_verify_offline,
            diagnostic_zip_create,
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
        ])
        .build(tauri::generate_context!());
    let app = result.map_err(|error| error.to_string())?;
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            // AppHandle clones can outlive the window; do not rely on managed
            // state Drop to stop the desktop-owned engine.
            handle.state::<engine_client::EngineClient>().shutdown();
        }
    });
    desktop_startup::record(
        "DESKTOP_EVENT_LOOP_EXITED",
        "Tauri event loop returned with managed-state cleanup",
    );
    Ok(())
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
