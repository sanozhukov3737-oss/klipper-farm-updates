mod actor;
mod async_websocket;
pub(crate) mod backup;
mod capabilities;
pub(crate) mod command_inbox;
mod database_writer;
pub(crate) mod diagnostics;
pub(crate) mod discovery;
pub(crate) mod durable_fs;
pub(crate) mod engine_lease;
pub(crate) mod engine_runtime;
mod farm_coordinator;
pub(crate) mod farm_queue;
pub(crate) mod farm_services;
mod fault_injection;
mod identity;
pub(crate) mod instance_lease;
pub(crate) mod journal;
pub(crate) mod migrations;
pub(crate) mod moonraker_transport;
mod profile_signing;
pub(crate) mod scheduler;
mod state_machine;
mod supervisor;
mod temperature;
pub(crate) mod upload;
pub(crate) mod verification;
pub(crate) mod workflow;

pub(crate) use diagnostics::diagnostic_zip_create;
pub(crate) use farm_services::{
    farm_queue_dispatch_v2, farm_queue_enqueue_v2, farm_queue_events_v3, farm_queue_transition_v3,
    maintenance_observe,
};
pub(crate) use profile_signing::{
    profile_signer_revoke, profile_signer_rotate, profile_signer_set, signed_profile_install,
};
pub(crate) use upload::{
    transactional_upload_abort, transactional_upload_begin, transactional_upload_chunk,
    transactional_upload_finish, transactional_upload_list, TransactionalUploadState,
};
pub(crate) use verification::verification_replay_plan;

use self::actor::{ActorEventSink, ActorHandle, BackgroundTask};
use self::journal::Journal;
use self::scheduler::FarmScheduler;
use self::types::{
    classify_method, ActorConfig, ActorConfigInput, ActorConnectionPresentation, ActorEvent,
    ActorSnapshot, OperationPriority,
    OperationRequest, OperationResult, RepeatPolicy, SchedulerSnapshot,
};
use crate::engine_client::EngineClient;
use crate::rpc::rpc_required_role;
use crate::{
    authorize_printer_target, moonraker_default_port, parse_role, require_role,
    stored_api_key, AuthState, Role,
};
use kf_ipc::EngineCommand;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub(crate) mod types;

// Upload completion can include transfer, checksum verification and publication.
// The IPC client must outlive this bounded actor wait.
pub(crate) const BACKGROUND_RESPONSE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(15 * 60);

const MAX_ACTOR_SNAPSHOT_TARGETS: usize = 512;
const MAX_ACTOR_SNAPSHOT_EVENTS: usize = 1_024;
const ACTOR_REGISTRY_KEY: &str = "headless.actor_registry.v1";
const MAX_ACTOR_REGISTRY_BYTES: usize = 2 * 1024 * 1024;
const MAX_PERSISTED_ACTORS: usize = 256;
const MAX_FIRMWARE_SIGNATURE_BYTES: usize = 512;

// Ports 80/7125 (and explicitly configured alternatives) are channels of one
// physical printer. Include an IPv6 scope so separate link-local interfaces
// are not accidentally treated as the same physical network address.
fn physical_address_key(host: &str, default_port: u16) -> Result<String, String> {
    let target = crate::parse_target(host, default_port)?;
    Ok(match target.socket {
        std::net::SocketAddr::V4(address) => address.ip().to_string(),
        std::net::SocketAddr::V6(address) => match address.ip().to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None => format!("{}%{}", address.ip(), address.scope_id()),
        },
    })
}

fn ensure_physical_address_claim(current: &[ActorConfig], config: &ActorConfig) -> Result<(), String> {
    let requested = physical_address_key(&config.host, config.default_port)?;
    for existing in current {
        if existing.printer_id != config.printer_id && physical_address_key(&existing.host, existing.default_port)? == requested {
            return Err("ADDRESS_IDENTITY_CONFLICT: этот IP уже занят другим физическим принтером; выполняется автоматическая проверка адресов".into());
        }
    }
    Ok(())
}

fn conflicting_registration_addresses(registrations: &[PersistedActorRegistration]) -> HashSet<String> {
    let mut counts = HashMap::<String, usize>::new();
    for registration in registrations {
        if let Ok(key) = physical_address_key(&registration.host, registration.default_port) {
            *counts.entry(key).or_default() += 1;
        }
    }
    counts.into_iter().filter_map(|(key, count)| (count > 1).then_some(key)).collect()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedActorRegistration {
    stable_id: String,
    printer_id: String,
    model_id: Option<String>,
    host: String,
    default_port: u16,
    firmware_signature: Option<String>,
}

impl PersistedActorRegistration {
    fn from_config(config: &ActorConfig) -> Self {
        Self {
            stable_id: config.stable_id.clone(),
            printer_id: config.printer_id.clone(),
            model_id: config.model_id.clone(),
            host: config.host.clone(),
            default_port: config.default_port,
            firmware_signature: config.firmware_signature.clone(),
        }
    }

    fn from_legacy(value: &Value) -> Option<Self> {
        let printer_id = value.get("id").and_then(Value::as_str)?;
        let host = value.get("host").and_then(Value::as_str)?;
        let stable_id = value
            .pointer("/deviceIdentity/stableId")
            .and_then(Value::as_str)
            .filter(|_| {
                value
                    .pointer("/deviceIdentity/dedupeSafe")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .unwrap_or(printer_id);
        let default_port = value
            .pointer("/profile/preset")
            .and_then(Value::as_str)
            .filter(|preset| *preset == "creality-k1c-2025")
            .map(|_| 80)
            .unwrap_or(7125);
        let firmware_signature = value
            .pointer("/configSnapshot/firmwareSignature")
            .and_then(Value::as_str)
            .map(str::to_string);
        let model_id = value
            .pointer("/modelSelection/selectedPreset")
            .or_else(|| value.pointer("/profile/preset"))
            .and_then(Value::as_str)
            .map(str::to_string);
        Some(Self {
            stable_id: stable_id.to_string(),
            printer_id: printer_id.to_string(),
            model_id,
            host: host.to_string(),
            default_port,
            firmware_signature,
        })
    }
}

fn read_actor_registry(
    connection: &rusqlite::Connection,
) -> Result<Option<Vec<PersistedActorRegistration>>, String> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM kv WHERE key=?1",
            [ACTOR_REGISTRY_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.len() > MAX_ACTOR_REGISTRY_BYTES {
        return Err("HEADLESS_ACTOR_REGISTRY_TOO_LARGE".into());
    }
    let registrations: Vec<PersistedActorRegistration> = serde_json::from_str(&raw)
        .map_err(|error| format!("HEADLESS_ACTOR_REGISTRY_INVALID: {error}"))?;
    if registrations.len() > MAX_PERSISTED_ACTORS {
        return Err(format!(
            "HEADLESS_ACTOR_REGISTRY_TOO_LARGE: maximum {MAX_PERSISTED_ACTORS}"
        ));
    }
    let mut stable_ids = HashSet::with_capacity(registrations.len());
    let mut printer_ids = HashSet::with_capacity(registrations.len());
    for registration in &registrations {
        validate_persisted_actor_registration(registration)?;
        if !stable_ids.insert(registration.stable_id.clone())
            || !printer_ids.insert(registration.printer_id.clone())
        {
            return Err("HEADLESS_ACTOR_REGISTRY_DUPLICATE".into());
        }
    }
    Ok(Some(registrations))
}

fn write_actor_registration_row(
    connection: &rusqlite::Connection,
    registration: PersistedActorRegistration,
    updated_at: i64,
) -> Result<(), String> {
    validate_persisted_actor_registration(&registration)?;
    let mut registrations = read_actor_registry(connection)?.unwrap_or_default();
    registrations.retain(|current| {
        current.stable_id != registration.stable_id
            && current.printer_id != registration.printer_id
    });
    if registrations.len() >= MAX_PERSISTED_ACTORS {
        return Err(format!(
            "HEADLESS_ACTOR_REGISTRY_FULL: maximum {MAX_PERSISTED_ACTORS}"
        ));
    }
    registrations.push(registration);
    registrations.sort_by(|left, right| left.stable_id.cmp(&right.stable_id));
    let raw = serde_json::to_string(&registrations).map_err(|error| error.to_string())?;
    if raw.len() > MAX_ACTOR_REGISTRY_BYTES {
        return Err("HEADLESS_ACTOR_REGISTRY_TOO_LARGE".into());
    }
    connection
        .execute(
            "INSERT INTO kv(key,value,updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![ACTOR_REGISTRY_KEY, raw, updated_at],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn delete_actor_registration_row(
    connection: &rusqlite::Connection,
    stable_id: &str,
    updated_at: i64,
) -> Result<bool, String> {
    let Some(mut registrations) = read_actor_registry(connection)? else {
        return Ok(false);
    };
    let previous_len = registrations.len();
    registrations.retain(|current| current.stable_id != stable_id);
    if registrations.len() == previous_len {
        return Ok(false);
    }
    let raw = serde_json::to_string(&registrations).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE kv SET value=?1,updated_at=?2 WHERE key=?3",
            rusqlite::params![raw, updated_at, ACTOR_REGISTRY_KEY],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn validate_persisted_actor_registration(
    registration: &PersistedActorRegistration,
) -> Result<(), String> {
    validate_stable_id(&registration.stable_id)?;
    validate_printer_id(&registration.printer_id)?;
    validate_model_id(registration.model_id.as_deref())?;
    moonraker_default_port(Some(registration.default_port))?;
    crate::parse_target(&registration.host, registration.default_port)?;
    if registration
        .firmware_signature
        .as_ref()
        .is_some_and(|value| value.len() > MAX_FIRMWARE_SIGNATURE_BYTES)
    {
        return Err("HEADLESS_ACTOR_FIRMWARE_SIGNATURE_TOO_LARGE".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActorSnapshotTargetInput {
    printer_id: String,
    host: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActorDesktopUpdates {
    snapshots: Vec<ActorDesktopSnapshot>,
    events: Vec<ActorEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActorDesktopSnapshot {
    #[serde(flatten)]
    snapshot: ActorSnapshot,
    presentation: ActorConnectionPresentation,
}

struct CoreInner {
    actors: Mutex<HashMap<String, ActorHandle>>,
    journal: Mutex<Option<Journal>>,
    app: Mutex<Option<AppHandle>>,
    scheduler: Arc<FarmScheduler>,
    restart_guard: Mutex<()>,
    address_guard: Mutex<()>,
    restart_budgets: Mutex<HashMap<String, supervisor::RestartBudget>>,
    supervisor_started: AtomicBool,
    coordinator_started: AtomicBool,
    runtime_stop: AtomicBool,
    runtime: Mutex<Option<engine_runtime::EngineRuntime>>,
    engine_lease: Mutex<Option<engine_lease::EngineLease>>,
    transport: Arc<dyn moonraker_transport::MoonrakerTransport>,
}

impl Default for CoreInner {
    fn default() -> Self {
        Self {
            actors: Mutex::new(HashMap::new()),
            journal: Mutex::new(None),
            app: Mutex::new(None),
            scheduler: Arc::new(FarmScheduler::default()),
            restart_guard: Mutex::new(()),
            address_guard: Mutex::new(()),
            restart_budgets: Mutex::new(HashMap::new()),
            supervisor_started: AtomicBool::new(false),
            coordinator_started: AtomicBool::new(false),
            runtime_stop: AtomicBool::new(false),
            runtime: Mutex::new(None),
            engine_lease: Mutex::new(None),
            transport: Arc::new(moonraker_transport::NativeMoonrakerTransport::default()),
        }
    }
}

impl CoreInner {
    fn runtime(&self) -> Result<engine_runtime::EngineRuntime, String> {
        let mut slot = self
            .runtime
            .lock()
            .map_err(|_| "Tokio runtime Transactional Core недоступен")?;
        if slot.is_none() {
            *slot = Some(engine_runtime::EngineRuntime::new()?);
        }
        slot.clone()
            .ok_or_else(|| "Tokio runtime Transactional Core не создан".into())
    }
}

impl Drop for CoreInner {
    fn drop(&mut self) {
        self.runtime_stop.store(true, Ordering::Release);
        if let Ok(actors) = self.actors.lock() {
            for actor in actors.values() {
                actor.shutdown();
            }
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct TransactionalCore {
    inner: Arc<CoreInner>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransactionalCoreRuntimeSnapshot {
    actors_total: usize,
    actors_alive: usize,
    actors_quarantined: usize,
    actors_restarting: usize,
    database_writer: database_writer::DatabaseWriterSnapshot,
    scheduler: SchedulerSnapshot,
    transport: moonraker_transport::TransportSnapshot,
    observability: crate::observability::ObservabilitySnapshot,
}

impl TransactionalCore {
    pub(crate) fn use_runtime_handle(&self, handle: tokio::runtime::Handle) -> Result<(), String> {
        let mut runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| "Tokio runtime Transactional Core недоступен")?;
        if runtime.is_none() {
            *runtime = Some(engine_runtime::EngineRuntime::from_handle(handle));
        }
        Ok(())
    }

    pub fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(client) = app.try_state::<EngineClient>() {
            client.ensure_embedded_initialization_allowed()?;
        }
        let path = crate::db_path(app)?;
        crate::headless_engine::ensure_embedded_engine_allowed(&path)?;
        self.initialize_path(&path, Some(app.clone()), "desktop")
    }

    pub(crate) fn initialize_headless(
        &self,
        database_path: &std::path::Path,
    ) -> Result<(), String> {
        self.initialize_path(database_path, None, "headless")
    }

    fn initialize_path(
        &self,
        path: &std::path::Path,
        app: Option<AppHandle>,
        owner: &str,
    ) -> Result<(), String> {
        let mut journal_slot = self
            .inner
            .journal
            .lock()
            .map_err(|_| "SQLite coordinator Transactional Core недоступен")?;
        if journal_slot.is_some() {
            drop(journal_slot);
            supervisor::start(&self.inner)?;
            return farm_coordinator::start(&self.inner);
        }
        let data_dir = path
            .parent()
            .ok_or("Путь SQLite не содержит каталог данных")?;
        crate::observability::initialize(data_dir)?;
        crate::observability::record(
            "info",
            "core",
            "CORE_INITIALIZING",
            None,
            "Transactional Core принимает ownership",
            serde_json::json!({"owner":owner,"schemaVersion":20}),
        );
        {
            let mut lease = self
                .inner
                .engine_lease
                .lock()
                .map_err(|_| "Engine ownership lease недоступен")?;
            if lease.is_none() {
                *lease = Some(engine_lease::EngineLease::acquire(data_dir, owner)?);
            }
        }
        let initialization = (|| {
            let mut connection = crate::database::open_connection(path)?;
            crate::database::initialize_base_schema(&connection)?;
            let _ = migrations::migrate_with_backup(&mut connection, path, crate::now_ms())?;
            let audit = crate::audit_chain::verify_and_backfill(&mut connection)?;
            crate::observability::record(
                "info",
                "audit_chain",
                "AUDIT_CHAIN_VERIFIED",
                None,
                "Tamper-evident audit chain verified",
                serde_json::json!({"entries":audit.verified_entries,"lastAuditId":audit.last_audit_id}),
            );
            Journal::new(path).map_err(|error| format!("SQLite journal {}: {error}", path.display()))
        })();
        let journal = match initialization {
            Ok(journal) => journal,
            Err(error) => {
                if let Ok(mut lease) = self.inner.engine_lease.lock() {
                    lease.take();
                }
                return Err(error);
            }
        };
        *journal_slot = Some(journal);
        *self
            .inner
            .app
            .lock()
            .map_err(|_| "AppHandle Transactional Core недоступен")? = app;
        drop(journal_slot);
        supervisor::start(&self.inner)?;
        farm_coordinator::start(&self.inner)
    }

    pub(crate) fn journal(&self) -> Result<Journal, String> {
        self.inner
            .journal
            .lock()
            .map_err(|_| "SQLite coordinator Transactional Core недоступен")?
            .clone()
            .ok_or_else(|| "Transactional Core ещё не инициализирован".into())
    }

    fn actor_by_printer_id(
        &self,
        printer_id: &str,
        restart_dead: bool,
    ) -> Result<Option<ActorHandle>, String> {
        let actor = {
            let actors = self
                .inner
                .actors
                .lock()
                .map_err(|_| "Реестр PrinterActor недоступен")?;
            actors
                .values()
                .find(|actor| actor.printer_id() == printer_id)
                .cloned()
        };
        let Some(actor) = actor else {
            return Ok(None);
        };
        if actor.is_alive() || !restart_dead {
            return Ok(Some(actor));
        }
        self.restart_dead_actor(&actor, false)?.map_or_else(
            || {
                Err(actor
                    .snapshot()
                    .last_error
                    .unwrap_or_else(|| "ACTOR_RESTART_BACKOFF".into()))
            },
            |replacement| Ok(Some(replacement)),
        )
    }

    fn restart_dead_actor(
        &self,
        stale: &ActorHandle,
        force: bool,
    ) -> Result<Option<ActorHandle>, String> {
        let _restart = self
            .inner
            .restart_guard
            .lock()
            .map_err(|_| "ActorSupervisor restart guard недоступен")?;
        let _address_claim = self.inner.address_guard.lock().map_err(|_| "Реестр адресов PrinterActor недоступен")?;
        let config = stale.config()?;
        if let Some(current) = self
            .inner
            .actors
            .lock()
            .map_err(|_| "Реестр PrinterActor недоступен")?
            .get(&config.stable_id)
            .filter(|current| current.is_alive())
            .cloned()
        {
            return Ok(Some(current));
        }

        let now = crate::now_ms();
        {
            let mut budgets = self
                .inner
                .restart_budgets
                .lock()
                .map_err(|_| "ActorSupervisor restart budget недоступен")?;
            let budget = budgets.entry(config.stable_id.clone()).or_default();
            if force {
                budget.reset();
            }
            match budget.decision(now) {
                supervisor::RestartDecision::Allow => budget.record_attempt(now),
                supervisor::RestartDecision::Wait(delay_ms) => {
                    stale.mark_restart_pending(delay_ms);
                    return Ok(None);
                }
                supervisor::RestartDecision::CrashLoop => {
                    stale.mark_crash_loop();
                    return Ok(None);
                }
            }
        }

        let app = self
            .inner
            .app
            .lock()
            .map_err(|_| "AppHandle Transactional Core недоступен")?
            .clone();
        let event_sink = app
            .map(ActorEventSink::desktop)
            .unwrap_or_else(ActorEventSink::headless);
        self.ensure_address_available(&config)?;
        let mut actors = self
            .inner
            .actors
            .lock()
            .map_err(|_| "Реестр PrinterActor недоступен")?;
        if let Some(current) = actors.get(&config.stable_id) {
            if current.is_alive() { return Ok(Some(current.clone())); }
        }
        let replacement = ActorHandle::spawn(
            event_sink,
            config.clone(),
            self.journal()?,
            Arc::clone(&self.inner.scheduler),
            self.inner.runtime()?,
            Arc::clone(&self.inner.transport),
        )?;
        let stale_keys: Vec<String> = actors
            .iter()
            .filter(|(_, current)| current.printer_id() == config.printer_id)
            .map(|(stable_id, _)| stable_id.clone())
            .collect();
        for stable_id in stale_keys {
            if let Some(stale) = actors.remove(&stable_id) {
                stale.shutdown();
            }
        }
        actors.insert(config.stable_id, replacement.clone());
        Ok(Some(replacement))
    }

    pub(super) fn supervise_dead_actors(&self) -> Result<(), String> {
        let actors: Vec<ActorHandle> = self
            .inner
            .actors
            .lock()
            .map_err(|_| "Реестр PrinterActor недоступен")?
            .values()
            .cloned()
            .collect();
        let now = crate::now_ms();
        for actor in actors {
            if actor.is_alive() {
                let stable_id = actor.config()?.stable_id;
                if let Ok(mut budgets) = self.inner.restart_budgets.lock() {
                    if let Some(budget) = budgets.get_mut(&stable_id) {
                        budget.record_healthy(now);
                    }
                }
            } else if let Err(error) = self.restart_dead_actor(&actor, false) {
                eprintln!("Klipper Farm ActorSupervisor restart: {error}");
            }
        }
        Ok(())
    }

    pub(crate) fn bootstrap_headless(
        &self,
        database_path: &std::path::Path,
    ) -> Result<usize, String> {
        self.initialize_headless(database_path)?;
        let bootstrapped = rusqlite::Connection::open(database_path)
            .map_err(|error| error.to_string())
            .and_then(|connection| {
                self.bootstrap_connection(&connection, ActorEventSink::headless())
            });
        match bootstrapped {
            Ok(started) => Ok(started),
            Err(error) => {
                // The database/core has already initialized successfully. A
                // malformed saved-printer row or an unavailable optional
                // credential must not prevent the daemon from publishing IPC:
                // the desktop will upsert every valid printer immediately.
                crate::observability::record(
                    "warn",
                    "headless_bootstrap",
                    "HEADLESS_ACTOR_BOOTSTRAP_DEGRADED",
                    None,
                    "Daemon запущен без предварительного восстановления сохранённых actors",
                    serde_json::json!({"error":&error}),
                );
                eprintln!(
                    "klipper-farmd: saved actor bootstrap degraded; IPC startup continues: {error}"
                );
                Ok(0)
            }
        }
    }

    fn bootstrap_connection(
        &self,
        connection: &rusqlite::Connection,
        event_sink: ActorEventSink,
    ) -> Result<usize, String> {
        let legacy_raw: Option<String> = connection
            .query_row(
                "SELECT value FROM kv WHERE key='printers.config'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let legacy_present = legacy_raw.is_some();
        let legacy_values = match legacy_raw.as_deref() {
            Some(raw) => serde_json::from_str::<Vec<Value>>(raw)
                .map_err(|error| format!("SAVED_PRINTER_CONFIG_INVALID: {error}")),
            None => Ok(Vec::new()),
        };
        let registry = read_actor_registry(connection);
        let registrations = match (legacy_present, legacy_values.as_ref(), registry) {
            (true, Ok(values), _) => values
                .iter()
                .filter_map(PersistedActorRegistration::from_legacy)
                .take(MAX_PERSISTED_ACTORS)
                .collect(),
            (true, Err(legacy_error), Ok(Some(registrations))) => {
                crate::observability::record(
                    "warn",
                    "headless_bootstrap",
                    "HEADLESS_ACTOR_REGISTRY_FALLBACK",
                    None,
                    "Конфигурация принтеров повреждена; используется подтверждённый daemon actor registry",
                    serde_json::json!({"error":legacy_error}),
                );
                registrations
            }
            (true, Err(legacy_error), Ok(None)) => return Err((*legacy_error).clone()),
            (true, Err(legacy_error), Err(registry_error)) => {
                return Err(format!(
                    "{legacy_error}; daemon registry unavailable: {registry_error}"
                ));
            }
            (false, _, Ok(Some(registrations))) => registrations,
            (false, _, Ok(None)) => Vec::new(),
            (false, _, Err(registry_error)) => return Err(registry_error),
        };
        let legacy_values = legacy_values.unwrap_or_default();
        // Never let registry order choose the owner of a duplicated address.
        // The authenticated desktop rechecks physical identities, repairs the
        // configuration atomically, and registers only a proven live owner.
        let conflicting_addresses = conflicting_registration_addresses(&registrations);
        let mut started = 0;
        for registration in registrations.into_iter().take(MAX_PERSISTED_ACTORS) {
            if physical_address_key(&registration.host, registration.default_port).ok().is_some_and(|key| conflicting_addresses.contains(&key)) {
                crate::observability::record("warn", "headless_bootstrap", "ADDRESS_IDENTITY_CONFLICT", Some(&registration.printer_id), "Повторный IP ожидает автоматического подтверждения физического принтера", serde_json::json!({}));
                continue;
            }
            let scheduler_weight = legacy_values
                .iter()
                .find(|value| {
                    value.get("id").and_then(Value::as_str)
                        == Some(registration.printer_id.as_str())
                })
                .and_then(|value| value.pointer("/profile/schedulerWeight"))
                .and_then(Value::as_f64)
                .filter(|weight| weight.is_finite())
                .unwrap_or(1.0)
                .clamp(0.25, 4.0);
            let stable_id = registration.stable_id.clone();
            let config = ActorConfig {
                stable_id: registration.stable_id,
                printer_id: registration.printer_id.clone(),
                model_id: registration.model_id,
                host: registration.host,
                default_port: registration.default_port,
                api_key: crate::stored_api_key_for_headless(&registration.printer_id)
                    .map(kf_domain::SecretString::new),
                firmware_signature: registration.firmware_signature,
                capabilities_hint: None,
            };
            match self.upsert_with_sink(event_sink.clone(), config) {
                Ok(_) => {
                    self.inner
                        .scheduler
                        .set_printer_weight(&stable_id, scheduler_weight);
                    started += 1;
                }
                Err(error) => {
                    crate::observability::record(
                        "warn",
                        "headless_bootstrap",
                        "HEADLESS_ACTOR_RESTORE_SKIPPED",
                        None,
                        "Один сохранённый PrinterActor не восстановлен; остальные продолжают запуск",
                        serde_json::json!({"error":error}),
                    );
                }
            }
        }
        Ok(started)
    }

    fn persist_actor_registration(&self, config: &ActorConfig) -> Result<(), String> {
        let registration = PersistedActorRegistration::from_config(config);
        let updated_at = crate::now_ms();
        self.journal()?.critical(move |connection| {
            write_actor_registration_row(connection, registration, updated_at)
        })
    }

    fn delete_actor_registration(&self, stable_id: &str) -> Result<bool, String> {
        let stable_id = stable_id.to_string();
        let updated_at = crate::now_ms();
        self.journal()?.critical(move |connection| {
            delete_actor_registration_row(connection, &stable_id, updated_at)
        })
    }

    fn ensure_address_available(&self, config: &ActorConfig) -> Result<(), String> {
        let current = {
            let actors = self.inner.actors.lock().map_err(|_| "Реестр PrinterActor недоступен")?;
            actors.values().map(ActorHandle::config).collect::<Result<Vec<_>, _>>()?
        };
        // Resolving a local hostname must not hold the snapshot registry lock.
        ensure_physical_address_claim(&current, config)
    }

    pub fn upsert(&self, app: AppHandle, config: ActorConfig) -> Result<ActorSnapshot, String> {
        self.upsert_with_sink(ActorEventSink::desktop(app), config)
    }

    pub(crate) fn upsert_headless(&self, config: ActorConfig) -> Result<ActorSnapshot, String> {
        self.upsert_with_sink(ActorEventSink::headless(), config)
    }

    fn upsert_with_sink(
        &self,
        event_sink: ActorEventSink,
        mut config: ActorConfig,
    ) -> Result<ActorSnapshot, String> {
        validate_stable_id(&config.stable_id)?;
        validate_printer_id(&config.printer_id)?;
        validate_model_id(config.model_id.as_deref())?;
        crate::parse_target(&config.host, config.default_port)?;
        let _address_claim = self.inner.address_guard.lock().map_err(|_| "Реестр адресов PrinterActor недоступен")?;
        let claimed_stable_id = config.stable_id.clone();
        let bound_stable_id = self.journal()?.stable_id_for_printer(&config.printer_id)?;
        let binding_conflict = bound_stable_id
            .filter(|bound| bound != &claimed_stable_id)
            .map(|bound| {
                config.stable_id = bound.clone();
                format!(
                    "IDENTITY_BINDING_DRIFT: WebView передал {claimed_stable_id}, Rust сохранил {bound}; сохранённая привязка оставлена без автоматической перепривязки"
                )
            });
        if let Some(reason) = binding_conflict.as_deref() {
            // The durable Rust binding is authoritative. A partial/updated
            // frontend fingerprint must neither rebind the printer nor put a
            // working endpoint into quarantine.
            crate::observability::record(
                "warn",
                "printer_actor",
                "IDENTITY_BINDING_DRIFT_IGNORED",
                Some(&config.printer_id),
                "Сохранённый stable ID сохранён; автоматический quarantine не применён",
                serde_json::json!({"detail":reason}),
            );
        }
        // ActorUpsert is a durable IPC command. Confirm the secret-free actor
        // registration in SQLite before returning or changing only in-memory
        // state, so an abrupt daemon termination cannot lose the actor.
        self.ensure_address_available(&config)?;
        // The separate claim lock serializes address ownership while SQLite
        // confirms it, without holding up ordinary snapshot/health reads.
        self.persist_actor_registration(&config)?;
        let mut actors = self.inner.actors.lock().map_err(|_| "Реестр PrinterActor недоступен")?;
        if let Some(actor) = actors.get(&config.stable_id).cloned() {
            if actor.is_alive() {
                match actor.reconfigure(config.clone()) {
                    Ok(snapshot) => return Ok(snapshot),
                    Err(error) if actor.is_alive() => return Err(error),
                    Err(_) => {}
                }
            }
            actors.remove(&config.stable_id);
            actor.shutdown();
        }
        let stale_keys: Vec<String> = actors
            .iter()
            .filter(|(_, actor)| actor.printer_id() == config.printer_id)
            .map(|(stable_id, _)| stable_id.clone())
            .collect();
        for stable_id in stale_keys {
            if let Some(actor) = actors.remove(&stable_id) {
                actor.shutdown();
            }
        }
        let actor = ActorHandle::spawn(
            event_sink,
            config.clone(),
            self.journal()?,
            Arc::clone(&self.inner.scheduler),
            self.inner.runtime()?,
            Arc::clone(&self.inner.transport),
        )?;
        let snapshot = actor.snapshot();
        actors.insert(config.stable_id, actor);
        Ok(snapshot)
    }

    pub fn execute_by_printer_id(
        &self,
        printer_id: &str,
        method: String,
        params: Option<Value>,
        prefer_rest: bool,
        timeout_ms: u64,
        expected_session_epoch: Option<u64>,
        operation_id: Option<String>,
        priority_override: Option<OperationPriority>,
        repeat_override: Option<RepeatPolicy>,
    ) -> Result<Option<OperationResult>, String> {
        let actor = self.actor_by_printer_id(printer_id, true)?;
        let Some(actor) = actor else {
            return Ok(None);
        };
        let (repeat_policy, priority) = classify_method(&method);
        let timeout_ms = timeout_ms.clamp(1_000, 120_000);
        let request = OperationRequest {
            operation_id: operation_id.unwrap_or(hex::encode(crate::random_bytes::<16>()?)),
            method,
            params,
            priority: priority_override.unwrap_or(priority),
            repeat_policy: repeat_override.unwrap_or(repeat_policy),
            prefer_rest,
            timeout_ms,
            deadline_at_ms: crate::now_ms()
                .saturating_add(timeout_ms as i64)
                .saturating_add(15_000),
            expected_session_epoch,
        };
        request.typed_operation_id()?;
        let snapshot = actor.snapshot();
        let journal = self.journal()?;
        let workflow_id = workflow::create_prepared(
            &journal,
            &snapshot.stable_id,
            snapshot.session_epoch,
            &request,
            crate::now_ms(),
        )?;
        fault_injection::check("workflow.after_prepare")?;
        let result = actor.execute(request);
        fault_injection::check("workflow.after_remote_result")?;
        workflow::observe_result(
            &journal,
            workflow_id.as_deref(),
            snapshot.session_epoch,
            &result,
            crate::now_ms(),
        )?;
        result.map(Some)
    }

    pub fn run_background_by_printer_id(
        &self,
        printer_id: &str,
        operation_id: String,
        cancelled: Arc<AtomicBool>,
        task: BackgroundTask,
    ) -> Result<Option<Value>, String> {
        let actor = self.actor_by_printer_id(printer_id, true)?;
        let Some(actor) = actor else {
            return Ok(None);
        };
        actor
            .run_background(operation_id, cancelled, task)
            .map(Some)
    }

    pub fn snapshot_for_printer(&self, printer_id: &str) -> Option<ActorSnapshot> {
        self.inner.actors.lock().ok().and_then(|actors| {
            actors
                .values()
                .find(|actor| actor.printer_id() == printer_id)
                .map(ActorHandle::snapshot)
        })
    }

    pub fn snapshots(&self) -> Vec<ActorSnapshot> {
        self.inner
            .actors
            .lock()
            .map(|actors| actors.values().map(ActorHandle::snapshot).collect())
            .unwrap_or_default()
    }

    pub fn cancel(&self, operation_id: &str) -> Result<bool, String> {
        validate_operation_id(operation_id)?;
        let actors = self
            .inner
            .actors
            .lock()
            .map_err(|_| "Реестр PrinterActor недоступен")?;
        for actor in actors.values() {
            if actor.cancel(operation_id)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn reattest_by_printer_id(&self, printer_id: &str) -> Result<ActorSnapshot, String> {
        let actor = self
            .actor_by_printer_id(printer_id, false)?
            .ok_or("PrinterActor для этого принтера ещё не создан")?;
        let actor = if actor.is_alive() {
            actor
        } else {
            self.restart_dead_actor(&actor, true)?
                .ok_or("ActorSupervisor не смог выполнить управляемый перезапуск")?
        };
        actor.reattest()
    }

    pub fn pending_events(
        &self,
        printer_id: &str,
        limit: usize,
    ) -> Result<Vec<ActorEvent>, String> {
        self.journal()?.pending_events(printer_id, limit)
    }

    pub fn acknowledge_events(
        &self,
        printer_id: &str,
        through_event_id: i64,
    ) -> Result<usize, String> {
        self.journal()?
            .acknowledge_events(printer_id, through_event_id, crate::now_ms())
    }

    pub fn remove(&self, stable_id: &str) -> Result<bool, String> {
        validate_stable_id(stable_id)?;
        let _address_claim = self.inner.address_guard.lock().map_err(|_| "Реестр адресов PrinterActor недоступен")?;
        // Delete the durable registration before stopping the live actor. If
        // SQLite cannot confirm the deletion, keep the actor alive and report
        // the failure rather than resurrecting it after the next restart.
        let registration_removed = self.delete_actor_registration(stable_id)?;
        let actor = self
            .inner
            .actors
            .lock()
            .map_err(|_| "Реестр PrinterActor недоступен")?
            .remove(stable_id);
        if let Some(actor) = actor {
            actor.shutdown();
            Ok(true)
        } else {
            Ok(registration_removed)
        }
    }

    pub fn scheduler(&self) -> Arc<FarmScheduler> {
        Arc::clone(&self.inner.scheduler)
    }

    pub fn scheduler_snapshot(&self) -> SchedulerSnapshot {
        self.inner.scheduler.snapshot()
    }

    pub fn runtime_snapshot(&self) -> Result<TransactionalCoreRuntimeSnapshot, String> {
        let actors: Vec<ActorHandle> = self
            .inner
            .actors
            .lock()
            .map_err(|_| "Реестр PrinterActor недоступен")?
            .values()
            .cloned()
            .collect();
        let snapshots: Vec<ActorSnapshot> = actors.iter().map(ActorHandle::snapshot).collect();
        Ok(TransactionalCoreRuntimeSnapshot {
            actors_total: actors.len(),
            actors_alive: actors.iter().filter(|actor| actor.is_alive()).count(),
            actors_quarantined: snapshots
                .iter()
                .filter(|snapshot| snapshot.phase == types::PrinterPhase::Quarantined)
                .count(),
            actors_restarting: actors
                .iter()
                .zip(&snapshots)
                .filter(|(actor, snapshot)| {
                    !actor.is_alive() && snapshot.phase != types::PrinterPhase::Quarantined
                })
                .count(),
            database_writer: self.journal()?.writer_snapshot(),
            scheduler: self.scheduler_snapshot(),
            transport: self.inner.transport.snapshot(),
            observability: crate::observability::snapshot(),
        })
    }

    pub fn journal_for_diagnostics(&self) -> Result<Journal, String> {
        self.journal()
    }
}

#[tauri::command]
pub(crate) async fn printer_actor_upsert(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    config: ActorConfigInput,
    api_key: Option<String>,
) -> Result<ActorDesktopSnapshot, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    authorize_printer_target(&app, &user, &config.printer_id, &config.host)?;
    if api_key.is_some() && parse_role(&user.role)? < Role::Admin {
        return Err("FORBIDDEN: только администратор может передавать новый API Key".into());
    }
    let default_port = moonraker_default_port(config.default_port)?;
    let key = match api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(value.trim().to_string()),
        None => stored_api_key(Some(&config.printer_id))?,
    };
    let use_daemon = client.route_to_daemon().await?;
    let snapshot: ActorSnapshot = if use_daemon {
        client
            .call_async(
                engine_runtime::ExecutionClass::ActorIo,
                EngineCommand::ActorUpsert,
                serde_json::json!({"config":config,"apiKey":key}),
            )
            .await?
    } else {
        core.initialize(&app)?;
        let actor_config = ActorConfig {
            stable_id: config.stable_id,
            printer_id: config.printer_id,
            model_id: config.model_id,
            host: config.host,
            default_port,
            api_key: key.map(kf_domain::SecretString::new),
            firmware_signature: config.firmware_signature,
            capabilities_hint: config.capabilities_hint,
        };
        engine_runtime::spawn_blocking(engine_runtime::ExecutionClass::ActorIo, {
            let app = app.clone();
            let core = core.inner().clone();
            move || core.upsert(app, actor_config)
        })
        .await
        .map_err(|error| format!("PrinterActor worker failed: {error}"))??
    };
    Ok(ActorDesktopSnapshot {
        presentation: snapshot.connection_presentation(crate::now_ms()),
        snapshot,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn printer_actor_rpc(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    printer_id: String,
    host: String,
    method: String,
    params: Option<Value>,
    prefer_rest: Option<bool>,
    timeout_ms: Option<u64>,
    expected_session_epoch: Option<u64>,
    operation_id: Option<String>,
) -> Result<OperationResult, String> {
    let role = rpc_required_role(&method, params.as_ref())?;
    let user = require_role(&app, &auth, &session_token, role)?;
    validate_printer_id(&printer_id)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::ActorIo,
                EngineCommand::ActorRpc,
                serde_json::json!({
                    "printerId":printer_id,
                    "method":method,
                    "params":params,
                    "preferRest":prefer_rest.unwrap_or(false),
                    "timeoutMs":timeout_ms,
                    "expectedSessionEpoch":expected_session_epoch,
                    "operationId":operation_id,
                }),
            )
            .await;
    }
    core.initialize(&app)?;
    let core = core.inner().clone();
    engine_runtime::spawn_blocking(engine_runtime::ExecutionClass::ActorIo, move || {
        core.execute_by_printer_id(
            &printer_id,
            method,
            params,
            prefer_rest.unwrap_or(false),
            timeout_ms.unwrap_or(8_000),
            expected_session_epoch,
            operation_id,
            None,
            None,
        )?
        .ok_or_else(|| "PrinterActor для этого принтера ещё не создан".into())
    })
    .await
    .map_err(|error| format!("PrinterActor RPC worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn printer_actor_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
) -> Result<Vec<ActorSnapshot>, String> {
    // The unfiltered actor registry contains every saved endpoint. Keep this
    // diagnostic command admin-only; the desktop uses the target-bound batch
    // command below so viewer/operator sessions cannot enumerate other hosts.
    require_role(&app, &auth, &session_token, Role::Admin)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::ActorIo,
                EngineCommand::ActorList,
                Value::Null,
            )
            .await;
    }
    core.initialize(&app)?;
    Ok(core.snapshots())
}

#[tauri::command]
pub(crate) async fn printer_actor_snapshots(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    targets: Vec<ActorSnapshotTargetInput>,
    include_events: Option<bool>,
) -> Result<ActorDesktopUpdates, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    if targets.len() > MAX_ACTOR_SNAPSHOT_TARGETS {
        return Err(format!(
            "Слишком много принтеров в одном запросе снимков: максимум {MAX_ACTOR_SNAPSHOT_TARGETS}"
        ));
    }
    let mut unique_targets = HashSet::with_capacity(targets.len());
    for target in &targets {
        validate_printer_id(&target.printer_id)?;
        authorize_printer_target(&app, &user, &target.printer_id, &target.host)?;
        let key = (
            target.printer_id.clone(),
            target.host.trim().to_ascii_lowercase(),
        );
        if !unique_targets.insert(key) {
            return Err("Один принтер повторён в запросе снимков".into());
        }
    }
    if targets.is_empty() {
        return Ok(ActorDesktopUpdates {
            snapshots: Vec::new(),
            events: Vec::new(),
        });
    }
    let use_daemon = client.route_to_daemon().await?;
    // IPC recovery and embedded compatibility work both stay outside Tauri's
    // command/event thread.
    let core = core.inner().clone();
    let client = client.inner().clone();
    engine_runtime::spawn_blocking(engine_runtime::ExecutionClass::ActorIo, move || {
        let snapshots: Vec<ActorSnapshot> = if use_daemon {
            client.call(EngineCommand::ActorList, Value::Null)?
        } else {
            core.initialize(&app)?;
            core.snapshots()
        };
        let observed_at = crate::now_ms();
        let snapshots = snapshots
            .into_iter()
            .filter(|snapshot| {
                targets.iter().any(|target| {
                    target.printer_id == snapshot.printer_id
                        && target
                            .host
                            .trim()
                            .eq_ignore_ascii_case(snapshot.host.trim())
                })
            })
            .map(|snapshot| ActorDesktopSnapshot {
                presentation: snapshot.connection_presentation(observed_at),
                snapshot,
            })
            .collect();
        let mut events = Vec::new();
        if include_events.unwrap_or(false) {
            for target in &targets {
                let remaining = MAX_ACTOR_SNAPSHOT_EVENTS.saturating_sub(events.len());
                if remaining == 0 {
                    break;
                }
                let limit = remaining.min(32);
                let mut pending: Vec<ActorEvent> = if use_daemon {
                    client.call(
                        EngineCommand::PendingEvents,
                        serde_json::json!({"printerId":target.printer_id,"limit":limit}),
                    )?
                } else {
                    core.pending_events(&target.printer_id, limit)?
                };
                events.append(&mut pending);
            }
            events.sort_by_key(|event| event.event_id);
        }
        Ok(ActorDesktopUpdates { snapshots, events })
    })
    .await
    .map_err(|error| format!("PrinterActor snapshot bridge worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn printer_actor_cancel(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    operation_id: String,
) -> Result<bool, String> {
    require_role(&app, &auth, &session_token, Role::Operator)?;
    if client.route_to_daemon().await? {
        let response: Value = client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::ActorCancel,
                serde_json::json!({"operationId":operation_id}),
            )
            .await?;
        return response
            .get("cancelled")
            .and_then(Value::as_bool)
            .ok_or("IPC_RESPONSE_SCHEMA: cancelled".into());
    }
    core.cancel(&operation_id)
}

#[tauri::command]
pub(crate) async fn printer_actor_remove(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    stable_id: String,
) -> Result<bool, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let use_daemon = client.route_to_daemon().await?;
    let client = client.inner().clone();
    let core = core.inner().clone();
    engine_runtime::spawn_blocking(engine_runtime::ExecutionClass::Control, move || {
        if use_daemon {
            let response: Value = client.call(
                EngineCommand::ActorRemove,
                serde_json::json!({"stableId":stable_id}),
            )?;
            return response
                .get("removed")
                .and_then(Value::as_bool)
                .ok_or("IPC_RESPONSE_SCHEMA: removed".into());
        }
        core.remove(&stable_id)
    })
    .await
    .map_err(|error| format!("PrinterActor remove worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn printer_actor_reattest(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    printer_id: String,
) -> Result<ActorSnapshot, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    validate_printer_id(&printer_id)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::ActorIo,
                EngineCommand::ActorReattest,
                serde_json::json!({"printerId":printer_id}),
            )
            .await;
    }
    core.initialize(&app)?;
    let core = core.inner().clone();
    engine_runtime::spawn_blocking(engine_runtime::ExecutionClass::ActorIo, move || {
        core.reattest_by_printer_id(&printer_id)
    })
    .await
    .map_err(|error| format!("PrinterActor reattest worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn printer_actor_events_pending(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    printer_id: String,
    host: String,
    limit: Option<usize>,
) -> Result<Vec<ActorEvent>, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    validate_printer_id(&printer_id)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::ActorIo,
                EngineCommand::PendingEvents,
                serde_json::json!({"printerId":printer_id,"limit":limit}),
            )
            .await;
    }
    core.initialize(&app)?;
    core.pending_events(&printer_id, limit.unwrap_or(512))
}

#[tauri::command]
pub(crate) async fn printer_actor_events_ack(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    printer_id: String,
    host: String,
    through_event_id: i64,
) -> Result<usize, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    validate_printer_id(&printer_id)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if client.route_to_daemon().await? {
        let response: Value = client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::AcknowledgeEvents,
                serde_json::json!({"printerId":printer_id,"throughEventId":through_event_id}),
            )
            .await?;
        return response
            .get("acknowledged")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .ok_or("IPC_RESPONSE_SCHEMA: acknowledged".into());
    }
    core.initialize(&app)?;
    core.acknowledge_events(&printer_id, through_event_id)
}

#[tauri::command]
pub(crate) async fn transactional_operations_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    state: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<journal::JournalOperationView>, String> {
    require_role(&app, &auth, &session_token, Role::Operator)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::ListOperations,
                serde_json::json!({"state":state,"limit":limit}),
            )
            .await;
    }
    core.initialize(&app)?;
    core.journal()?
        .list_operations(state.as_deref(), limit.unwrap_or(250))
}

#[tauri::command]
pub(crate) async fn transactional_operation_resolve(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    operation_id: String,
    resolution: String,
    reason: String,
) -> Result<(), String> {
    let user = require_role(&app, &auth, &session_token, Role::Admin)?;
    validate_operation_id(&operation_id)?;
    if client.route_to_daemon().await? {
        let _: Value = client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::ResolveOperation,
                serde_json::json!({
                    "operationId":operation_id,
                    "resolution":resolution,
                    "reason":reason,
                    "resolvedBy":user.id,
                }),
            )
            .await?;
        return Ok(());
    }
    core.initialize(&app)?;
    core.journal()?.resolve_unknown(
        &operation_id,
        &resolution,
        &reason,
        &user.id,
        crate::now_ms(),
    )?;
    crate::insert_audit(
        &app,
        &user.id,
        "operations.unknown_resolved",
        &format!("operation_id={operation_id}; resolution={resolution}; reason={reason}"),
    )
}

#[tauri::command]
pub(crate) async fn transactional_journal_housekeeping(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    retention_days: Option<u64>,
) -> Result<journal::JournalHousekeepingReport, String> {
    let user = require_role(&app, &auth, &session_token, Role::Admin)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::Housekeeping,
                serde_json::json!({"retentionDays":retention_days}),
            )
            .await;
    }
    core.initialize(&app)?;
    let report = core
        .journal()?
        .housekeeping(crate::now_ms(), retention_days.unwrap_or(90))?;
    crate::insert_audit(
        &app,
        &user.id,
        "operations.journal_housekeeping",
        &format!(
            "archived={}; expired_archives={}; expired_events={}",
            report.archived_commands, report.expired_archives, report.expired_events
        ),
    )?;
    Ok(report)
}

#[tauri::command]
pub(crate) async fn farm_scheduler_snapshot(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
) -> Result<SchedulerSnapshot, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::SchedulerSnapshot,
                Value::Null,
            )
            .await;
    }
    Ok(core.scheduler_snapshot())
}

#[tauri::command]
pub(crate) async fn farm_scheduler_set_printer_weight(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
    stable_id: String,
    weight: f64,
) -> Result<(), String> {
    let user = require_role(&app, &auth, &session_token, Role::Admin)?;
    validate_stable_id(&stable_id)?;
    if !weight.is_finite() || !(0.25..=4.0).contains(&weight) {
        return Err("Вес принтера должен быть от 0.25 до 4.0".into());
    }
    if client.route_to_daemon().await? {
        let _: Value = client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::SchedulerSetWeight,
                serde_json::json!({"stableId":stable_id,"weight":weight,"changedBy":user.id}),
            )
            .await?;
        return Ok(());
    }
    core.initialize(&app)?;
    core.scheduler().set_printer_weight(&stable_id, weight);
    crate::insert_audit(
        &app,
        &user.id,
        "scheduler.printer_weight",
        &format!("stable_id={stable_id}; weight={weight:.2}"),
    )
}

#[tauri::command]
pub(crate) async fn transactional_core_runtime_snapshot(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, EngineClient>,
    session_token: String,
) -> Result<TransactionalCoreRuntimeSnapshot, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    if client.route_to_daemon().await? {
        return client
            .call_async(
                engine_runtime::ExecutionClass::Control,
                EngineCommand::RuntimeSnapshot,
                Value::Null,
            )
            .await;
    }
    core.initialize(&app)?;
    core.runtime_snapshot()
}

fn validate_stable_id(value: &str) -> Result<(), String> {
    if value.len() < 3 || kf_domain::StableId::parse(value).is_err() {
        return Err("Недопустимый stable ID принтера".into());
    }
    Ok(())
}

fn validate_printer_id(value: &str) -> Result<(), String> {
    if kf_domain::PrinterId::parse(value).is_err() {
        return Err("Недопустимый ID карточки принтера".into());
    }
    Ok(())
}

fn validate_model_id(value: Option<&str>) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Недопустимый ID модели принтера".into());
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || kf_domain::OperationId::parse(value).is_err() {
        return Err("Недопустимый ID операции".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(stable_id: &str, printer_id: &str) -> PersistedActorRegistration {
        PersistedActorRegistration {
            stable_id: stable_id.into(),
            printer_id: printer_id.into(),
            model_id: Some("creality-k1c-2025".into()),
            host: "127.0.0.1:7125".into(),
            default_port: 7125,
            firmware_signature: None,
        }
    }

    #[test]
    fn physical_address_claim_excludes_ports_but_keeps_distinct_ips_and_scopes() {
        assert_eq!(physical_address_key("192.168.1.12", 7125).unwrap(), physical_address_key("http://192.168.1.12:80/", 80).unwrap());
        assert_ne!(physical_address_key("127.0.0.1:10001", 7125).unwrap(), physical_address_key("127.0.0.2:10001", 7125).unwrap());
        // The transport rejects IPv4-mapped IPv6 before opening a socket;
        // an unsupported spelling cannot bypass the address claim guard.
        assert!(physical_address_key("[::ffff:192.168.1.12]:7125", 7125).is_err());
        assert_ne!(physical_address_key("[fe80::1%2]:80", 80).unwrap(), physical_address_key("[fe80::1%3]:80", 80).unwrap());
    }

    #[test]
    fn physical_address_claim_allows_same_printer_failover_and_rejects_other_ids() {
        let config = |id: &str, host: &str| ActorConfig {stable_id:id.into(),printer_id:id.into(),model_id:None,host:host.into(),default_port:7125,api_key:None,firmware_signature:None,capabilities_hint:None};
        let current = vec![config("one", "192.168.1.12:7125")];
        assert!(ensure_physical_address_claim(&current, &config("one", "192.168.1.12:80")).is_ok());
        assert!(ensure_physical_address_claim(&current, &config("two", "192.168.1.12:80")).unwrap_err().starts_with("ADDRESS_IDENTITY_CONFLICT"));
        assert!(ensure_physical_address_claim(&current, &config("two", "192.168.1.13:80")).is_ok());
    }

    #[test]
    fn bootstrap_marks_every_duplicate_address_without_choosing_first_card() {
        let mut rows = vec![registration("one", "one"), registration("two", "two"), registration("three", "three"), registration("other", "other")];
        rows[1].host = "http://127.0.0.1:80/".into();
        rows[2].host = "127.0.0.1:10000".into();
        rows[3].host = "127.0.0.2:7125".into();
        let expected = HashSet::from(["127.0.0.1".to_string()]);
        assert_eq!(conflicting_registration_addresses(&rows), expected);
        rows.reverse();
        assert_eq!(conflicting_registration_addresses(&rows), expected);
    }

    #[test]
    fn durable_actor_registry_round_trips_replaces_and_deletes_without_secrets() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::database::initialize_base_schema(&connection).unwrap();

        write_actor_registration_row(
            &connection,
            registration("stable-one", "printer-one"),
            10,
        )
        .unwrap();
        let first = read_actor_registry(&connection).unwrap().unwrap();
        assert_eq!(first, vec![registration("stable-one", "printer-one")]);

        write_actor_registration_row(
            &connection,
            registration("stable-rebound", "printer-one"),
            11,
        )
        .unwrap();
        let rebound = read_actor_registry(&connection).unwrap().unwrap();
        assert_eq!(
            rebound,
            vec![registration("stable-rebound", "printer-one")]
        );

        let raw: String = connection
            .query_row(
                "SELECT value FROM kv WHERE key=?1",
                [ACTOR_REGISTRY_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw.contains("apiKey") && !raw.contains("token"));
        assert!(delete_actor_registration_row(
            &connection,
            "stable-rebound",
            12
        )
        .unwrap());
        assert_eq!(read_actor_registry(&connection).unwrap(), Some(Vec::new()));
        assert!(!delete_actor_registration_row(
            &connection,
            "stable-rebound",
            13
        )
        .unwrap());
    }
}
