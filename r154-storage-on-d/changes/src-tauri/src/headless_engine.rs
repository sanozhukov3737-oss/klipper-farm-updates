use crate::transactional_core::farm_queue::{self, FarmJobState};
use crate::transactional_core::farm_services::{self, FarmQueueJob};
use crate::transactional_core::journal::Journal;
use crate::transactional_core::types::{ActorConfig, ActorConfigInput};
use crate::transactional_core::upload::{self, TransactionalUploadState};
use crate::transactional_core::TransactionalCore;
use crate::{core_error::CoreError, transactional_core::command_inbox};
use kf_domain::SecretBytes;
use kf_ipc::{
    EndpointRecord, EngineCommand, EngineRequest, EngineResponse, IpcErrorDetail, MAX_FRAME_BYTES,
    MIN_COMPATIBLE_VERSION, PROTOCOL_VERSION,
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream as StdTcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::runtime::Builder;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

#[cfg(unix)]
use std::os::unix::net::{UnixListener as LocalListener, UnixStream as LocalStream};
#[cfg(windows)]
use uds_windows::{UnixListener as LocalListener, UnixStream as LocalStream};

const ENDPOINT_FILENAME: &str = "klipper-farmd.endpoint.json";
const SOCKET_FILENAME: &str = "kf20.sock";
const MAX_SOCKET_PATH_BYTES: usize = 100;
const MAX_IPC_CONNECTIONS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOWS_RUNTIME_FILE_ATTEMPTS: usize = 10;

struct RotatingToken {
    current: SecretBytes,
    previous: Option<(SecretBytes, i64)>,
}

#[derive(Clone)]
struct EngineState {
    core: TransactionalCore,
    journal: Journal,
    data_dir: Arc<PathBuf>,
    uploads: TransactionalUploadState,
    token: Arc<RwLock<RotatingToken>>,
    token_generation: Arc<AtomicU64>,
    endpoint_path: Arc<PathBuf>,
    socket_endpoint: Arc<String>,
    started_at: i64,
    shutdown: Arc<AtomicBool>,
    bootstrapped_actors: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListFarmJobsInput {
    state: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FarmJobEventsInput {
    job_id: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionFarmJobInput {
    job_id: String,
    expected_state: String,
    target_state: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HousekeepingInput {
    retention_days: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActorUpsertInput {
    config: ActorConfigInput,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActorRpcInput {
    printer_id: String,
    method: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    prefer_rest: bool,
    timeout_ms: Option<u64>,
    expected_session_epoch: Option<u64>,
    operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrinterInput {
    printer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationInput {
    operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StableIdInput {
    stable_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingEventsInput {
    printer_id: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcknowledgeEventsInput {
    printer_id: String,
    through_event_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowListInput {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowResolveInput {
    workflow_id: String,
    expected_version: u64,
    resolution: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveOperationInput {
    operation_id: String,
    resolution: String,
    reason: String,
    resolved_by: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SchedulerSetWeightInput {
    stable_id: String,
    weight: f64,
    changed_by: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FarmQueueEnqueueInput {
    actor: String,
    job: FarmQueueJob,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FarmQueueDispatchInput {
    actor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceObserveInput {
    actor: String,
    stable_id: String,
    print_seconds: u64,
    heating_errors: u64,
    reconnects: u64,
    interrupted_jobs: u64,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadBeginInput {
    owner_id: String,
    stable_id: String,
    printer_id: String,
    host: String,
    filename: String,
    file_size: u64,
    expected_sha256: String,
    default_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadChunkInput {
    owner_id: String,
    upload_id: String,
    offset: u64,
    data_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadOwnerInput {
    owner_id: String,
    upload_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEndpointRecord {
    protocol_version: u16,
    #[serde(default)]
    transport: String,
    #[serde(default)]
    socket_path: String,
    #[serde(default)]
    port: Option<u16>,
    token: String,
}

struct EndpointGuard {
    path: PathBuf,
    socket_path: PathBuf,
    started_at: i64,
}

impl EndpointGuard {
    fn cleanup(&self) -> Result<(), String> {
        let owned = fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<EndpointRecord>(&raw).ok())
            .is_some_and(|record| {
                record.pid == std::process::id() && record.started_at == self.started_at
            });
        if !owned {
            return Ok(());
        }
        remove_runtime_file(&self.socket_path, "IPC socket")?;
        remove_runtime_file(&self.path, "engine endpoint")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IpcProbeInput {
    request_id: String,
    command: EngineCommand,
    #[serde(default)]
    payload: Value,
}

impl Drop for EndpointGuard {
    fn drop(&mut self) {
        // The normal path calls cleanup explicitly so a failure is returned to
        // the caller. Drop remains the unwind/early-return safety net.
        let _ = self.cleanup();
    }
}

pub fn run_from_args<I, S>(arguments: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let data_dir = parse_data_dir(arguments)?;
    secure_data_directory(&data_dir)?;
    let runtime = Builder::new_multi_thread()
        .worker_threads(
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
                .clamp(2, 8),
        )
        .thread_name("klipper-farmd-runtime")
        .enable_all()
        .build()
        .map_err(|error| format!("Не удалось создать runtime klipper-farmd: {error}"))?;
    runtime.block_on(run_server(data_dir))
}

/// Executes one authenticated request against a running headless engine.
///
/// This entry point exists for the packaged Windows runtime verification. Node's
/// `net` IPC path denotes a Windows named pipe, while the production desktop and
/// daemon intentionally use Windows AF_UNIX through `uds_windows`. Keeping the
/// probe in Rust makes the release gate exercise the exact production transport
/// instead of testing an incompatible Node transport abstraction.
pub fn run_ipc_probe_from_args<I, S>(arguments: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let data_dir = parse_data_dir(arguments)?;
    let mut raw = Vec::new();
    std::io::stdin()
        .lock()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|error| format!("IPC_PROBE_STDIN: {error}"))?;
    if raw.is_empty() || raw.len() > MAX_FRAME_BYTES {
        return Err("IPC_PROBE_REQUEST_SIZE".into());
    }
    let input: IpcProbeInput =
        serde_json::from_slice(&raw).map_err(|error| format!("IPC_PROBE_SCHEMA: {error}"))?;
    let request_id = kf_domain::RequestId::parse(input.request_id)
        .map_err(|error| format!("IPC_PROBE_REQUEST_ID: {error}"))?;
    let response = call_published_endpoint(
        &data_dir.join(ENDPOINT_FILENAME),
        request_id,
        input.command,
        input.payload,
    )?;
    let output = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    stdout
        .write_all(&output)
        .map_err(|error| format!("IPC_PROBE_STDOUT: {error}"))?;
    stdout
        .flush()
        .map_err(|error| format!("IPC_PROBE_STDOUT: {error}"))
}

fn call_published_endpoint(
    endpoint_path: &Path,
    request_id: kf_domain::RequestId,
    command: EngineCommand,
    payload: Value,
) -> Result<EngineResponse, String> {
    crate::engine_client::call_path_with_request_id(endpoint_path, command, payload, request_id)
}

pub(crate) fn ensure_embedded_engine_allowed(database_path: &Path) -> Result<(), String> {
    let Some(parent) = database_path.parent() else {
        return Err("Путь SQLite не содержит каталог данных".into());
    };
    let endpoint = parent.join(ENDPOINT_FILENAME);
    if !endpoint.exists() {
        return Ok(());
    }
    if probe_existing(&endpoint) {
        return Err(
            "HEADLESS_ENGINE_ACTIVE: klipper-farmd уже владеет ядром; остановите daemon перед запуском desktop compatibility mode"
                .into(),
        );
    }
    fs::remove_file(&endpoint)
        .map_err(|error| format!("Не удалось удалить stale engine endpoint: {error}"))
}

async fn run_server(data_dir: PathBuf) -> Result<(), String> {
    let database_path = data_dir.join("farm.sqlite3");
    let core = TransactionalCore::default();
    core.use_runtime_handle(tokio::runtime::Handle::current())?;
    let bootstrapped_actors = core.bootstrap_headless(&database_path)?;
    let journal = core.journal()?;
    // bootstrap_headless already owns the process-wide engine lease. Retire a
    // crash-left endpoint before binding the replacement socket; otherwise
    // publish_endpoint would probe the newly bound listener through the old
    // record before the accept loop exists, then log Windows WSAECONNRESET when
    // those timed-out self-probes are finally accepted.
    let endpoint_path = data_dir.join(ENDPOINT_FILENAME);
    retire_stale_endpoint_after_lease(&endpoint_path)?;
    let socket_path = resolve_socket_path(&data_dir)?;
    remove_stale_socket(&socket_path)?;
    let listener = LocalListener::bind(&socket_path)
        .map_err(|error| format!("Не удалось открыть local IPC socket: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    secure_socket(&socket_path)?;
    let token_bytes = crate::random_bytes::<32>()?;
    let token = hex::encode(token_bytes);
    let started_at = crate::now_ms();
    let token_generation = journal.critical(move |connection| {
        connection
            .execute(
                "UPDATE daemon_metadata
                 SET owner_pid=?1,owner_started_at=?2,updated_at=?2
                 WHERE singleton=1",
                params![std::process::id() as i64, started_at],
            )
            .map_err(|error| error.to_string())?;
        connection
            .query_row(
                "SELECT token_generation FROM daemon_metadata WHERE singleton=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value.max(1) as u64)
            .map_err(|error| error.to_string())
    })?;
    let socket_endpoint = socket_path.to_string_lossy().into_owned();
    let endpoint = EndpointRecord {
        protocol_version: PROTOCOL_VERSION,
        minimum_client_version: MIN_COMPATIBLE_VERSION,
        pid: std::process::id(),
        transport: "local_socket".into(),
        endpoint: socket_endpoint.clone(),
        token: token.clone(),
        token_generation,
        started_at,
    };
    publish_endpoint(&endpoint_path, &endpoint)?;
    let endpoint_guard = EndpointGuard {
        path: endpoint_path.clone(),
        socket_path,
        started_at,
    };
    let state = EngineState {
        core,
        journal,
        data_dir: Arc::new(data_dir),
        uploads: TransactionalUploadState::default(),
        token: Arc::new(RwLock::new(RotatingToken {
            current: SecretBytes::new(token_bytes.to_vec()),
            previous: None,
        })),
        token_generation: Arc::new(AtomicU64::new(token_generation)),
        endpoint_path: Arc::new(endpoint_path.clone()),
        socket_endpoint: Arc::new(socket_endpoint),
        started_at,
        shutdown: Arc::new(AtomicBool::new(false)),
        bootstrapped_actors,
    };
    let connection_gate = Arc::new(Semaphore::new(MAX_IPC_CONNECTIONS));
    let mut connections = JoinSet::new();
    println!("klipper-farmd endpoint: {}", endpoint_path.display());

    let server_result = loop {
        while let Some(result) = connections.try_join_next() {
            if let Err(error) = result {
                eprintln!("klipper-farmd IPC task: {error}");
            }
        }
        if state.shutdown.load(Ordering::Acquire) {
            break Ok(());
        }
        match listener.accept() {
            Ok((stream, _peer)) => {
                let Ok(connection_permit) = Arc::clone(&connection_gate).try_acquire_owned() else {
                    crate::observability::record(
                        "warn",
                        "headless_ipc",
                        "IPC_BACKPRESSURE",
                        None,
                        "Лимит одновременных IPC-соединений исчерпан",
                        serde_json::json!({"limit":MAX_IPC_CONNECTIONS}),
                    );
                    drop(stream);
                    continue;
                };
                let connection_state = state.clone();
                drop(connections.spawn(async move {
                    let result = crate::transactional_core::engine_runtime::spawn_blocking(
                        crate::transactional_core::engine_runtime::ExecutionClass::Control,
                        move || handle_connection(stream, connection_state),
                    )
                    .await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => eprintln!("klipper-farmd IPC: {error}"),
                        Err(error) => eprintln!("klipper-farmd IPC worker: {error}"),
                    }
                    drop(connection_permit);
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => break Err(format!("Local IPC accept failed: {error}")),
        }
    };
    // Windows keeps the AF_UNIX pathname busy while either the listener or an
    // accepted stream is alive. Stop accepting first, then join every tracked
    // IPC task before EndpointGuard removes e.sock. This order is required for
    // deterministic same-process restart after the shutdown response.
    drop(listener);
    while let Some(result) = connections.join_next().await {
        if let Err(error) = result {
            eprintln!("klipper-farmd IPC task during shutdown: {error}");
        }
    }
    drop(state);
    let cleanup_result = endpoint_guard.cleanup();
    drop(endpoint_guard);
    server_result.and(cleanup_result)
}

fn handle_connection(mut stream: LocalStream, state: EngineState) -> Result<(), String> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let request = read_request(&mut stream)?;
    let request_id = request.request_id.clone();
    let response = if let Err(error) = authenticate_request(&request, &state.token) {
        response_error(request_id, error)
    } else {
        let dispatch_state = state.clone();
        let result = {
            let durable = request.command.durable();
            let request_id = request.request_id.clone();
            let command = request.command.as_str();
            if durable {
                let fingerprint = command_inbox::payload_sha256(command, &request.payload)?;
                match command_inbox::begin(
                    &dispatch_state.journal,
                    request_id.as_str(),
                    command,
                    &fingerprint,
                    crate::now_ms(),
                )? {
                    command_inbox::InboxDecision::Execute => {
                        let result = dispatch(request, &dispatch_state).map_err(|error| {
                            CoreError::from_legacy(error)
                                .with_operation_id(Some(request_id.as_str()))
                        });
                        command_inbox::finish(
                            &dispatch_state.journal,
                            request_id.as_str(),
                            &result,
                            crate::now_ms(),
                        )?;
                        result
                    }
                    command_inbox::InboxDecision::Replay(result) => result,
                }
            } else {
                dispatch(request, &dispatch_state).map_err(|error| {
                    CoreError::from_legacy(error).with_operation_id(Some(request_id.as_str()))
                })
            }
        };
        match result {
            Ok(data) => response_ok(request_id, data),
            Err(error) => response_error(request_id, error),
        }
    };
    write_response(&mut stream, &response)
}

fn dispatch(request: EngineRequest, state: &EngineState) -> Result<Value, String> {
    match request.command {
        EngineCommand::Negotiate => kf_ipc::negotiate(request.protocol_version)
            .map_err(str::to_string)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        EngineCommand::Health => health(state),
        EngineCommand::RuntimeSnapshot => state
            .core
            .runtime_snapshot()
            .and_then(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string())),
        EngineCommand::ActorList => {
            serde_json::to_value(state.core.snapshots()).map_err(|error| error.to_string())
        }
        EngineCommand::ActorUpsert => actor_upsert(state, request.payload),
        EngineCommand::ActorRpc => actor_rpc(state, request.payload),
        EngineCommand::ActorReattest => actor_reattest(state, request.payload),
        EngineCommand::ActorCancel => actor_cancel(state, request.payload),
        EngineCommand::ActorRemove => actor_remove(state, request.payload),
        EngineCommand::PendingEvents => pending_events(state, request.payload),
        EngineCommand::AcknowledgeEvents => acknowledge_events(state, request.payload),
        EngineCommand::DatabaseSnapshot => {
            serde_json::to_value(state.journal.writer_snapshot()).map_err(|error| error.to_string())
        }
        EngineCommand::ListOperations => state
            .journal
            .list_operations(
                request.payload.get("state").and_then(Value::as_str),
                request
                    .payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(250) as usize,
            )
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        EngineCommand::ResolveOperation => resolve_operation(state, request.payload),
        EngineCommand::SchedulerSnapshot => {
            serde_json::to_value(state.core.scheduler_snapshot()).map_err(|error| error.to_string())
        }
        EngineCommand::SchedulerSetWeight => scheduler_set_weight(state, request.payload),
        EngineCommand::FarmQueueEnqueue => farm_queue_enqueue(state, request.payload),
        EngineCommand::FarmQueueDispatch => farm_queue_dispatch(state, request.payload),
        EngineCommand::ListFarmJobs => list_farm_jobs(state, request.payload),
        EngineCommand::FarmJobEvents => farm_job_events(state, request.payload),
        EngineCommand::TransitionFarmJob => {
            transition_farm_job(state, request.request_id.as_str(), request.payload)
        }
        EngineCommand::MaintenanceObserve => maintenance_observe(state, request.payload),
        EngineCommand::Housekeeping => housekeeping(state, request.payload),
        EngineCommand::BackupNow => {
            state.journal.flush_telemetry()?;
            crate::transactional_core::backup::create_on_demand(
                state.journal.database_path(),
                crate::now_ms(),
            )
            .and_then(|report| serde_json::to_value(report).map_err(|error| error.to_string()))
        }
        EngineCommand::UploadBegin => upload_begin(state, request.payload),
        EngineCommand::UploadChunk => upload_chunk(state, request.payload),
        EngineCommand::UploadFinish => upload_finish(state, request.payload),
        EngineCommand::UploadAbort => upload_abort(state, request.payload),
        EngineCommand::UploadList => upload::daemon_list(&state.journal)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        EngineCommand::WorkflowList => {
            let input: WorkflowListInput = serde_json::from_value(request.payload)
                .map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
            crate::transactional_core::workflow::list(&state.journal, input.limit.unwrap_or(250))
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        EngineCommand::WorkflowResolve => {
            let input: WorkflowResolveInput = serde_json::from_value(request.payload)
                .map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
            crate::transactional_core::workflow::resolve_unknown(
                &state.journal,
                &input.workflow_id,
                input.expected_version,
                &input.resolution,
                &input.reason,
                &format!("ipc:{}", request.request_id),
                crate::now_ms(),
            )
            .map(|state_version| serde_json::json!({"stateVersion":state_version}))
        }
        EngineCommand::RotateToken => rotate_token(state),
        EngineCommand::Shutdown => {
            state.shutdown.store(true, Ordering::Release);
            Ok(serde_json::json!({"accepted":true}))
        }
    }
}

fn farm_queue_enqueue(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: FarmQueueEnqueueInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    farm_services::daemon_enqueue(&state.core, &input.actor, input.job)
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn farm_queue_dispatch(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: FarmQueueDispatchInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    farm_services::daemon_dispatch(&state.core, &input.actor)
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn maintenance_observe(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: MaintenanceObserveInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    farm_services::daemon_maintenance_observe(
        &state.core,
        &input.actor,
        &input.stable_id,
        input.print_seconds,
        input.heating_errors,
        input.reconnects,
        input.interrupted_jobs,
        input.payload,
    )
    .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn upload_begin(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: UploadBeginInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    upload::daemon_begin(
        &state.core,
        &state.data_dir,
        &input.owner_id,
        &input.stable_id,
        &input.printer_id,
        &input.host,
        &input.filename,
        input.file_size,
        &input.expected_sha256,
        input.default_port,
    )
    .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn upload_chunk(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: UploadChunkInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    if input.data_hex.len() > crate::MAX_UPLOAD_CHUNK.saturating_mul(2) {
        return Err("IPC_UPLOAD_CHUNK_TOO_LARGE".into());
    }
    let data = hex::decode(&input.data_hex)
        .map_err(|error| format!("IPC_UPLOAD_CHUNK_ENCODING: {error}"))?;
    upload::daemon_chunk(
        &state.journal,
        &state.uploads,
        &state.data_dir,
        &input.owner_id,
        &input.upload_id,
        input.offset,
        &data,
    )
    .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn upload_finish(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: UploadOwnerInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    upload::daemon_finish(
        &state.core,
        &state.uploads,
        &state.data_dir,
        &input.owner_id,
        &input.upload_id,
    )
    .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn upload_abort(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: UploadOwnerInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    upload::daemon_abort(
        &state.journal,
        &state.uploads,
        &state.data_dir,
        &input.owner_id,
        &input.upload_id,
    )
    .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn health(state: &EngineState) -> Result<Value, String> {
    let (actors, jobs, unknown_operations) = state.journal.read(|connection| {
        let actors = count(connection, "SELECT COUNT(*) FROM printer_actor_state")?;
        let jobs = count(
            connection,
            "SELECT COUNT(*) FROM farm_queue_v2 WHERE state NOT IN ('completed','cancelled','failed')",
        )?;
        let unknown_operations = count(
            connection,
            "SELECT COUNT(*) FROM command_journal WHERE state='unknown'",
        )?;
        Ok((actors, jobs, unknown_operations))
    })?;
    Ok(serde_json::json!({
        "status":"ok",
        "protocolVersion":PROTOCOL_VERSION,
        "minimumClientVersion":MIN_COMPATIBLE_VERSION,
        "tokenGeneration":state.token_generation.load(Ordering::Acquire),
        "pid":std::process::id(),
        "startedAt":state.started_at,
        "uptimeMs":crate::now_ms().saturating_sub(state.started_at),
        "actorsPersisted":actors,
        "actorsBootstrapped":state.bootstrapped_actors,
        "actorsLive":state.core.snapshots().len(),
        "activeFarmJobs":jobs,
        "unknownOperations":unknown_operations,
        "databaseWriter":state.journal.writer_snapshot(),
        "observability":crate::observability::snapshot(),
    }))
}

fn actor_upsert(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: ActorUpsertInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    let default_port = crate::moonraker_default_port(input.config.default_port)?;
    let api_key = input
        .api_key
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .or_else(|| crate::stored_api_key_for_headless(&input.config.printer_id));
    let config = ActorConfig {
        stable_id: input.config.stable_id,
        printer_id: input.config.printer_id.clone(),
        model_id: input.config.model_id,
        host: input.config.host,
        default_port,
        api_key: api_key.map(kf_domain::SecretString::new),
        firmware_signature: input.config.firmware_signature,
        capabilities_hint: input.config.capabilities_hint,
    };
    state
        .core
        .upsert_headless(config)
        .and_then(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string()))
}

fn actor_rpc(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: ActorRpcInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .core
        .execute_by_printer_id(
            &input.printer_id,
            input.method,
            input.params,
            input.prefer_rest,
            input.timeout_ms.unwrap_or(8_000),
            input.expected_session_epoch,
            input.operation_id,
            None,
            None,
        )?
        .ok_or_else(|| "PrinterActor для этого принтера ещё не создан".into())
        .and_then(|result| serde_json::to_value(result).map_err(|error| error.to_string()))
}

fn actor_reattest(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: PrinterInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .core
        .reattest_by_printer_id(&input.printer_id)
        .and_then(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string()))
}

fn actor_cancel(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: OperationInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .core
        .cancel(&input.operation_id)
        .map(|cancelled| serde_json::json!({"cancelled":cancelled}))
}

fn actor_remove(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: StableIdInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .core
        .remove(&input.stable_id)
        .map(|removed| serde_json::json!({"removed":removed}))
}

fn pending_events(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: PendingEventsInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .core
        .pending_events(&input.printer_id, input.limit.unwrap_or(512))
        .and_then(|events| serde_json::to_value(events).map_err(|error| error.to_string()))
}

fn acknowledge_events(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: AcknowledgeEventsInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .core
        .acknowledge_events(&input.printer_id, input.through_event_id)
        .map(|acknowledged| serde_json::json!({"acknowledged":acknowledged}))
}

fn list_farm_jobs(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: ListFarmJobsInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    if let Some(filter) = input.state.as_deref() {
        FarmJobState::parse(filter)?;
    }
    state.journal.read(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT job_id,filename,state,state_version,assigned_stable_id,priority,
                        last_error,last_transition_reason,created_at,updated_at
                 FROM farm_queue_v2
                 WHERE (?1 IS NULL OR state=?1)
                 ORDER BY priority DESC,created_at ASC LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    input.state,
                    input.limit.unwrap_or(250).clamp(1, 2_000) as i64
                ],
                |row| {
                    Ok(serde_json::json!({
                        "jobId":row.get::<_,String>(0)?,
                        "filename":row.get::<_,String>(1)?,
                        "state":row.get::<_,String>(2)?,
                        "stateVersion":row.get::<_,i64>(3)?.max(0),
                        "assignedStableId":row.get::<_,Option<String>>(4)?,
                        "priority":row.get::<_,i64>(5)?,
                        "lastError":row.get::<_,Option<String>>(6)?,
                        "lastTransitionReason":row.get::<_,Option<String>>(7)?,
                        "createdAt":row.get::<_,i64>(8)?,
                        "updatedAt":row.get::<_,i64>(9)?,
                    }))
                },
            )
            .map_err(|error| error.to_string())?;
        let rows = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(Value::Array(rows))
    })
}

fn farm_job_events(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: FarmJobEventsInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    validate_job_id(&input.job_id)?;
    state
        .journal
        .farm_job_events(&input.job_id, input.limit.unwrap_or(512))
        .and_then(|events| serde_json::to_value(events).map_err(|error| error.to_string()))
}

fn transition_farm_job(
    state: &EngineState,
    request_id: &str,
    payload: Value,
) -> Result<Value, String> {
    let input: TransitionFarmJobInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    validate_job_id(&input.job_id)?;
    if input.reason.trim().len() < 3 || input.reason.len() > 2_048 {
        return Err("Причина перехода должна содержать 3–2048 символов".into());
    }
    let expected = FarmJobState::parse(&input.expected_state)?;
    let target = FarmJobState::parse(&input.target_state)?;
    let actor = format!("ipc:{request_id}");
    let now = crate::now_ms();
    let job_id = input.job_id;
    let reason = input.reason;
    let version = state.journal.critical(move |connection| {
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let version = farm_queue::transition_in_transaction(
            &transaction,
            &job_id,
            expected,
            target,
            &actor,
            Some(reason.trim()),
            now,
        )?;
        crate::audit_chain::insert(
            &transaction,
            now,
            &actor,
            "farm_queue.ipc_transition",
            &format!("job_id={job_id};{}->{}", expected.as_str(), target.as_str()),
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(version)
    })?;
    Ok(serde_json::json!({"stateVersion":version}))
}

fn housekeeping(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: HousekeepingInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    state
        .journal
        .housekeeping(crate::now_ms(), input.retention_days.unwrap_or(90))
        .and_then(|report| serde_json::to_value(report).map_err(|error| error.to_string()))
}

fn resolve_operation(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: ResolveOperationInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    kf_domain::OperationId::parse(&input.operation_id).map_err(|error| error.to_string())?;
    state.journal.resolve_unknown(
        &input.operation_id,
        &input.resolution,
        &input.reason,
        &input.resolved_by,
        crate::now_ms(),
    )?;
    let actor = input.resolved_by;
    let details = format!(
        "operation_id={};resolution={};reason={}",
        input.operation_id, input.resolution, input.reason
    );
    state.journal.critical(move |connection| {
        crate::audit_chain::insert(
            connection,
            crate::now_ms(),
            &actor,
            "operations.unknown_resolved",
            &details,
        )
    })?;
    Ok(serde_json::json!({"resolved":true}))
}

fn scheduler_set_weight(state: &EngineState, payload: Value) -> Result<Value, String> {
    let input: SchedulerSetWeightInput =
        serde_json::from_value(payload).map_err(|error| format!("IPC_BAD_PAYLOAD: {error}"))?;
    kf_domain::StableId::parse(&input.stable_id).map_err(|error| error.to_string())?;
    if !input.weight.is_finite() || !(0.25..=4.0).contains(&input.weight) {
        return Err("SCHEDULER_WEIGHT_INVALID".into());
    }
    state
        .core
        .scheduler()
        .set_printer_weight(&input.stable_id, input.weight);
    let actor = input.changed_by;
    let details = format!("stable_id={};weight={:.2}", input.stable_id, input.weight);
    state.journal.critical(move |connection| {
        crate::audit_chain::insert(
            connection,
            crate::now_ms(),
            &actor,
            "scheduler.printer_weight",
            &details,
        )
    })?;
    Ok(serde_json::json!({"updated":true}))
}

fn rotate_token(state: &EngineState) -> Result<Value, String> {
    let token_bytes = crate::random_bytes::<32>()?;
    let token_text = hex::encode(token_bytes);
    let now = crate::now_ms();
    let generation = state.journal.critical(move |connection| {
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE daemon_metadata
                 SET token_generation=token_generation+1,updated_at=?1
                 WHERE singleton=1",
                [now],
            )
            .map_err(|error| error.to_string())?;
        let generation = transaction
            .query_row(
                "SELECT token_generation FROM daemon_metadata WHERE singleton=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            .max(1) as u64;
        crate::audit_chain::insert(
            &transaction,
            now,
            "daemon",
            "ipc.token_rotated",
            &format!("generation={generation}"),
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(generation)
    })?;
    let endpoint = EndpointRecord {
        protocol_version: PROTOCOL_VERSION,
        minimum_client_version: MIN_COMPATIBLE_VERSION,
        pid: std::process::id(),
        transport: "local_socket".into(),
        endpoint: state.socket_endpoint.as_ref().clone(),
        token: token_text.clone(),
        token_generation: generation,
        started_at: state.started_at,
    };
    let mut current = state
        .token
        .write()
        .map_err(|_| "IPC_TOKEN_LOCK_POISONED".to_string())?;
    replace_endpoint(&state.endpoint_path, &endpoint)?;
    let previous = std::mem::replace(&mut current.current, SecretBytes::new(token_bytes.to_vec()));
    current.previous = Some((previous, now.saturating_add(5_000)));
    state.token_generation.store(generation, Ordering::Release);
    Ok(serde_json::json!({
        "token":token_text,
        "tokenGeneration":generation,
        "previousTokenValidUntil":now.saturating_add(5_000),
    }))
}

fn read_request(stream: &mut LocalStream) -> Result<EngineRequest, String> {
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("IPC_FRAME_HEADER: {error}"))?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err("IPC_FRAME_TOO_LARGE".into());
    }
    let mut payload = vec![0_u8; size];
    stream
        .read_exact(&mut payload)
        .map_err(|error| format!("IPC_FRAME_BODY: {error}"))?;
    serde_json::from_slice(&payload).map_err(|error| format!("IPC_BAD_JSON: {error}"))
}

fn write_response(stream: &mut LocalStream, response: &EngineResponse) -> Result<(), String> {
    let payload = serde_json::to_vec(response).map_err(|error| error.to_string())?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err("IPC_RESPONSE_TOO_LARGE".into());
    }
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&payload)
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

fn authenticate_request(
    request: &EngineRequest,
    expected_token: &RwLock<RotatingToken>,
) -> Result<(), CoreError> {
    if !(MIN_COMPATIBLE_VERSION..=PROTOCOL_VERSION).contains(&request.protocol_version) {
        return Err(CoreError::from_legacy("IPC_PROTOCOL_VERSION_MISMATCH"));
    }
    let mut candidate =
        hex::decode(&request.token).map_err(|_| CoreError::from_legacy("IPC_UNAUTHORIZED"))?;
    let authenticated = if candidate.len() == 32 {
        let token = expected_token
            .read()
            .map_err(|_| CoreError::from_legacy("IPC_TOKEN_LOCK_POISONED"))?;
        bool::from(candidate.as_slice().ct_eq(token.current.expose()))
            || token
                .previous
                .as_ref()
                .is_some_and(|(previous, expires_at)| {
                    crate::now_ms() <= *expires_at
                        && bool::from(candidate.as_slice().ct_eq(previous.expose()))
                })
    } else {
        false
    };
    candidate.fill(0);
    if !authenticated {
        return Err(CoreError::from_legacy("IPC_UNAUTHORIZED"));
    }
    Ok(())
}

fn response_ok(request_id: kf_domain::RequestId, data: Value) -> EngineResponse {
    EngineResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        ok: true,
        data: Some(data),
        error: None,
        error_detail: None,
    }
}

fn response_error(request_id: kf_domain::RequestId, error: CoreError) -> EngineResponse {
    EngineResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        ok: false,
        data: None,
        error: Some(error.message.clone()),
        error_detail: Some(IpcErrorDetail {
            code: error.code,
            class: error.class.to_string(),
            retryable: error.retryable,
            operation_id: error.operation_id,
        }),
    }
}

fn publish_endpoint(path: &Path, endpoint: &EndpointRecord) -> Result<(), String> {
    if path.exists() {
        for _ in 0..5 {
            if probe_existing(path) {
                return Err("ENGINE_ALREADY_RUNNING".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    replace_endpoint(path, endpoint)
}

fn replace_endpoint(path: &Path, endpoint: &EndpointRecord) -> Result<(), String> {
    let temporary = path.with_extension(format!("json.{}.partial", std::process::id()));
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Не удалось захватить engine endpoint: {error}"))?;
    crate::set_private_file_permissions(&temporary)?;
    let raw = serde_json::to_vec(endpoint).map_err(|error| error.to_string())?;
    file.write_all(&raw).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if let Err(error) = crate::transactional_core::durable_fs::rename_atomic(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    crate::set_private_file_permissions(path)
}

fn probe_existing(path: &Path) -> bool {
    let Some(raw) = fs::read_to_string(path).ok() else {
        return false;
    };
    let (protocol_version, transport, endpoint_path, port, token) =
        if let Ok(endpoint) = serde_json::from_str::<EndpointRecord>(&raw) {
            (
                endpoint.protocol_version,
                endpoint.transport,
                endpoint.endpoint,
                None,
                endpoint.token,
            )
        } else if let Ok(endpoint) = serde_json::from_str::<LegacyEndpointRecord>(&raw) {
            (
                endpoint.protocol_version,
                endpoint.transport,
                endpoint.socket_path,
                endpoint.port,
                endpoint.token,
            )
        } else {
            return false;
        };
    let Ok(request_id) = kf_domain::RequestId::parse("probe") else {
        return false;
    };
    let request = EngineRequest {
        protocol_version,
        request_id,
        token,
        command: EngineCommand::Health,
        payload: Value::Null,
    };
    if transport == "local_socket" && !endpoint_path.is_empty() {
        let Ok(mut stream) = LocalStream::connect(&endpoint_path) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        return probe_stream(&mut stream, &request);
    }
    let Some(port) = port else {
        return false;
    };
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = StdTcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    probe_stream(&mut stream, &request)
}

fn probe_stream<S: Read + Write>(stream: &mut S, request: &EngineRequest) -> bool {
    let Ok(payload) = serde_json::to_vec(&request) else {
        return false;
    };
    if stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .is_err()
        || stream.write_all(&payload).is_err()
    {
        return false;
    }
    let mut header = [0_u8; 4];
    if stream.read_exact(&mut header).is_err() {
        return false;
    }
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return false;
    }
    let mut response = vec![0_u8; size];
    stream.read_exact(&mut response).is_ok()
        && serde_json::from_slice::<EngineResponse>(&response).is_ok_and(|response| response.ok)
}

fn parse_data_dir<I, S>(arguments: I) -> Result<PathBuf, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut arguments = arguments.into_iter().map(Into::into);
    let _program = arguments.next();
    let mut data_dir = None;
    while let Some(argument) = arguments.next() {
        if argument == "--data-dir" {
            data_dir = Some(arguments.next().ok_or("--data-dir требует путь")?.into());
        } else {
            return Err(format!(
                "Неизвестный аргумент klipper-farmd: {}",
                argument.to_string_lossy()
            ));
        }
    }
    data_dir
        .or_else(|| std::env::var_os("KLIPPER_FARM_DATA_DIR").map(PathBuf::from))
        .or_else(default_data_dir)
        .ok_or("Не удалось определить каталог данных klipper-farmd".into())
}

fn default_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // Демон выбирает тот же корень, что и клиент, если его не позвали с --data-dir.
        Some(crate::storage_paths::root_without_app())
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join(".local/share"))
            })
            .map(|path| path.join(crate::storage_paths::APP_IDENTIFIER))
    }
}

fn secure_data_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    crate::set_private_directory_permissions(path)
}

fn resolve_socket_path(data_dir: &Path) -> Result<PathBuf, String> {
    let direct = data_dir.join(SOCKET_FILENAME);
    if socket_path_length(&direct).is_ok_and(|length| length < MAX_SOCKET_PATH_BYTES) {
        return Ok(direct);
    }

    let canonical = fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    let digest = socket_identity_digest(&canonical);
    let mut runtime_roots = Vec::new();
    #[cfg(windows)]
    {
        push_unique_env_path(&mut runtime_roots, "LOCALAPPDATA");
        push_unique_env_path(&mut runtime_roots, "USERPROFILE");
    }
    #[cfg(unix)]
    push_unique_env_path(&mut runtime_roots, "XDG_RUNTIME_DIR");
    push_unique_path(&mut runtime_roots, std::env::temp_dir());
    #[cfg(unix)]
    push_unique_path(&mut runtime_roots, PathBuf::from("/tmp"));
    #[cfg(windows)]
    {
        let mut ancestors = data_dir
            .ancestors()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        ancestors.reverse();
        for ancestor in ancestors {
            push_unique_path(&mut runtime_roots, ancestor);
        }
    }

    let mut failures = Vec::new();
    for root in runtime_roots {
        let directory = root.join(".kf").join(&digest[..24]);
        let candidate = directory.join("e.sock");
        let length = match socket_path_length(&candidate) {
            Ok(length) if length < MAX_SOCKET_PATH_BYTES => length,
            Ok(_) => continue,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        match prepare_socket_directory(&directory) {
            Ok(()) => {
                debug_assert!(length < MAX_SOCKET_PATH_BYTES);
                return Ok(candidate);
            }
            Err(error) => failures.push(error),
        }
    }
    Err(format!(
        "IPC_SOCKET_PATH_UNAVAILABLE: не удалось создать короткий приватный local socket ({} попыток)",
        failures.len()
    ))
}

fn socket_identity_digest(path: &Path) -> String {
    let mut hasher = Sha256::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(path.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in path.as_os_str().encode_wide() {
            hasher.update(unit.to_le_bytes());
        }
    }
    #[cfg(not(any(unix, windows)))]
    hasher.update(path.to_string_lossy().as_bytes());
    hex::encode(hasher.finalize())
}

fn socket_path_length(path: &Path) -> Result<usize, String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(path.as_os_str().as_bytes().len())
    }
    #[cfg(windows)]
    {
        path.to_str()
            .map(|value| value.len())
            .ok_or("IPC_SOCKET_PATH_ENCODING: Windows local socket требует UTF-8 путь".into())
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.to_str()
            .map(|value| value.len())
            .ok_or("IPC_SOCKET_PATH_ENCODING".into())
    }
}

fn push_unique_env_path(paths: &mut Vec<PathBuf>, name: &str) {
    if let Some(path) = std::env::var_os(name).map(PathBuf::from) {
        push_unique_path(paths, path);
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_absolute() && !paths.contains(&path) {
        paths.push(path);
    }
}

fn prepare_socket_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!("IPC_SOCKET_DIRECTORY_UNSAFE: {}", path.display()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| {
                format!("IPC_SOCKET_DIRECTORY_CREATE {}: {error}", path.display())
            })?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("IPC_SOCKET_DIRECTORY_UNSAFE: {}", path.display()));
    }
    crate::set_private_directory_permissions(path)
}

fn remove_stale_socket(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_dir() => {
            Err(format!("IPC_SOCKET_PATH_UNSAFE: {}", path.display()))
        }
        Ok(_) => remove_runtime_file(path, "stale IPC socket"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn retire_stale_endpoint_after_lease(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_dir() => {
            Err(format!("IPC_ENDPOINT_PATH_UNSAFE: {}", path.display()))
        }
        Ok(_) => remove_runtime_file(path, "stale engine endpoint"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_runtime_file(path: &Path, label: &str) -> Result<(), String> {
    let attempts = if cfg!(windows) {
        WINDOWS_RUNTIME_FILE_ATTEMPTS
    } else {
        1
    };
    for attempt in 0..attempts {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && attempt + 1 < attempts
                    && matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33)) =>
            {
                std::thread::sleep(Duration::from_millis(25_u64 << attempt.min(3)));
            }
            Err(error) => {
                return Err(format!("Не удалось удалить {label} {}: {error}", path.display()));
            }
        }
    }
    Err(format!(
        "Не удалось удалить {label} {}: исчерпан Windows retry",
        path.display()
    ))
}

fn secure_socket(path: &Path) -> Result<(), String> {
    crate::set_private_file_permissions(path)
}

fn count(connection: &Connection, query: &str) -> Result<i64, String> {
    connection
        .query_row(query, [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn validate_job_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("Недопустимый ID farm-job".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(endpoint: &EndpointRecord, command: EngineCommand) -> EngineResponse {
        call_with_payload(endpoint, command, Value::Null)
    }

    fn call_with_payload(
        endpoint: &EndpointRecord,
        command: EngineCommand,
        payload: Value,
    ) -> EngineResponse {
        let command_name = command.as_str().to_string();
        let mut stream = LocalStream::connect(&endpoint.endpoint)
            .unwrap_or_else(|error| panic!("{command_name}: IPC_CONNECT: {error}"));
        stream
            .set_read_timeout(Some(crate::engine_client::IPC_TIMEOUT))
            .unwrap_or_else(|error| panic!("{command_name}: IPC_SET_READ_TIMEOUT: {error}"));
        stream
            .set_write_timeout(Some(crate::engine_client::IPC_TIMEOUT))
            .unwrap_or_else(|error| panic!("{command_name}: IPC_SET_WRITE_TIMEOUT: {error}"));
        let request = EngineRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: kf_domain::RequestId::parse(format!("test-{}", command.as_str())).unwrap(),
            token: endpoint.token.clone(),
            command,
            payload,
        };
        let payload = serde_json::to_vec(&request).unwrap();
        stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .unwrap_or_else(|error| panic!("{command_name}: IPC_WRITE_HEADER: {error}"));
        stream
            .write_all(&payload)
            .unwrap_or_else(|error| panic!("{command_name}: IPC_WRITE_BODY: {error}"));
        stream
            .flush()
            .unwrap_or_else(|error| panic!("{command_name}: IPC_FLUSH: {error}"));
        let mut header = [0_u8; 4];
        stream
            .read_exact(&mut header)
            .unwrap_or_else(|error| panic!("{command_name}: IPC_READ_HEADER: {error}"));
        let mut response = vec![0_u8; u32::from_be_bytes(header) as usize];
        stream
            .read_exact(&mut response)
            .unwrap_or_else(|error| panic!("{command_name}: IPC_READ_BODY: {error}"));
        serde_json::from_slice(&response)
            .unwrap_or_else(|error| panic!("{command_name}: IPC_BAD_RESPONSE: {error}"))
    }

    #[test]
    fn ipc_authentication_is_constant_length_and_fail_closed() {
        let expected = "ab".repeat(32);
        let expected_bytes = hex::decode(&expected).unwrap();
        let token = RwLock::new(RotatingToken {
            current: SecretBytes::new(expected_bytes),
            previous: None,
        });
        let mut request = EngineRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: kf_domain::RequestId::parse("request-1").unwrap(),
            token: expected.clone(),
            command: EngineCommand::Health,
            payload: Value::Null,
        };
        assert!(authenticate_request(&request, &token).is_ok());
        request.token = "cd".repeat(32);
        assert_eq!(
            authenticate_request(&request, &token).unwrap_err().code,
            "IPC_UNAUTHORIZED"
        );
        request.token = expected;
        request.protocol_version += 1;
        assert_eq!(
            authenticate_request(&request, &token).unwrap_err().code,
            "IPC_PROTOCOL_VERSION_MISMATCH"
        );
    }

    #[test]
    fn explicit_data_dir_wins_over_environment() {
        let parsed = parse_data_dir(["klipper-farmd", "--data-dir", "/tmp/kf-v20"]).unwrap();
        assert_eq!(parsed, PathBuf::from("/tmp/kf-v20"));
    }

    #[test]
    fn ipc_schema_rejects_unknown_fields_and_unknown_commands() {
        let base = serde_json::json!({
            "protocolVersion":PROTOCOL_VERSION,
            "requestId":"request-1",
            "token":"00",
            "command":"health",
            "payload":null
        });
        assert!(serde_json::from_value::<EngineRequest>(base.clone()).is_ok());
        let mut unknown_field = base.clone();
        unknown_field["surprise"] = Value::Bool(true);
        assert!(serde_json::from_value::<EngineRequest>(unknown_field).is_err());
        let mut unknown_command = base;
        unknown_command["command"] = Value::String("execute_arbitrary_code".into());
        assert!(serde_json::from_value::<EngineRequest>(unknown_command).is_err());
    }

    #[test]
    fn ipc_probe_schema_is_strict_and_never_accepts_a_caller_token() {
        let valid = serde_json::json!({
            "requestId":"probe-1",
            "command":"health",
            "payload":null
        });
        assert!(serde_json::from_value::<IpcProbeInput>(valid.clone()).is_ok());
        let mut injected_token = valid;
        injected_token["token"] = Value::String("caller-controlled".into());
        assert!(serde_json::from_value::<IpcProbeInput>(injected_token).is_err());
    }

    #[test]
    fn long_data_directory_uses_a_short_private_socket_path() {
        let data_dir = std::env::temp_dir().join(format!(
            "kfd20-path-{}-{}-{}",
            std::process::id(),
            crate::now_ms(),
            "x".repeat(80)
        ));
        fs::create_dir_all(&data_dir).unwrap();
        let direct = data_dir.join(SOCKET_FILENAME);
        assert!(socket_path_length(&direct).unwrap() >= MAX_SOCKET_PATH_BYTES);

        let resolved = resolve_socket_path(&data_dir).unwrap();
        assert!(socket_path_length(&resolved).unwrap() < MAX_SOCKET_PATH_BYTES);
        assert_ne!(resolved.parent(), Some(data_dir.as_path()));
        let runtime_directory = resolved.parent().unwrap().to_path_buf();
        let metadata = fs::symlink_metadata(&runtime_directory).unwrap();
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());

        let _ = fs::remove_dir(&runtime_directory);
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn crash_left_endpoint_is_retired_before_rebinding_the_socket() {
        let data_dir = std::env::temp_dir().join(format!(
            "kfd20-stale-endpoint-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        let endpoint_path = data_dir.join(ENDPOINT_FILENAME);
        fs::write(&endpoint_path, b"crash-left endpoint").unwrap();
        retire_stale_endpoint_after_lease(&endpoint_path).unwrap();
        assert!(!endpoint_path.exists());

        fs::create_dir(&endpoint_path).unwrap();
        assert!(retire_stale_endpoint_after_lease(&endpoint_path)
            .unwrap_err()
            .contains("IPC_ENDPOINT_PATH_UNSAFE"));
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn headless_daemon_serves_authenticated_health_and_shutdown() {
        let _serial = crate::transactional_core::engine_lease::TEST_ENGINE_LEASE_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let data_dir = std::env::temp_dir().join(format!(
            "kfd20-{}-{}-{}",
            std::process::id(),
            crate::now_ms(),
            "x".repeat(80)
        ));
        assert!(
            socket_path_length(&data_dir.join(SOCKET_FILENAME)).unwrap() >= MAX_SOCKET_PATH_BYTES,
            "regression fixture must require the short runtime socket fallback"
        );
        let worker_dir = data_dir.clone();
        let (result_sender, result_receiver) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let result = run_from_args([
                OsString::from("klipper-farmd"),
                OsString::from("--data-dir"),
                worker_dir.into_os_string(),
            ]);
            let _ = result_sender.send(result.clone());
            result
        });
        let endpoint_path = data_dir.join(ENDPOINT_FILENAME);
        let mut endpoint = None;
        for _ in 0..400 {
            endpoint = fs::read_to_string(&endpoint_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<EndpointRecord>(&raw).ok());
            if endpoint.is_some() {
                break;
            }
            if let Ok(result) = result_receiver.try_recv() {
                let sandbox_blocked_socket = cfg!(unix)
                    && std::env::var_os("CODEX_SANDBOX_NETWORK_DISABLED").is_some()
                    && result
                        .as_ref()
                        .is_err_and(|error| error.contains("Operation not permitted (os error 1)"));
                if sandbox_blocked_socket {
                    worker.join().unwrap().unwrap_err();
                    let _ = fs::remove_dir_all(data_dir);
                    eprintln!("local socket bind integration skipped by the Codex sandbox");
                    return;
                }
                panic!("daemon exited before publishing endpoint: {result:?}");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let endpoint = endpoint.expect("daemon endpoint");
        assert!(socket_path_length(Path::new(&endpoint.endpoint)).unwrap() < MAX_SOCKET_PATH_BYTES);
        assert_ne!(
            Path::new(&endpoint.endpoint).parent(),
            Some(data_dir.as_path())
        );
        let health = call_published_endpoint(
            &endpoint_path,
            kf_domain::RequestId::parse("native-probe-health").unwrap(),
            EngineCommand::Health,
            Value::Null,
        )
        .unwrap();
        assert!(health.ok, "{:?}", health.error);
        assert_eq!(
            health
                .data
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str),
            Some("ok")
        );
        let actors = call(&endpoint, EngineCommand::ActorList);
        assert!(actors.ok, "{:?}", actors.error);
        assert_eq!(actors.data, Some(Value::Array(Vec::new())));
        let upsert = call_with_payload(
            &endpoint,
            EngineCommand::ActorUpsert,
            serde_json::json!({
                "config":{
                    "stableId":"runtime-restart-actor",
                    "printerId":"printer-restart-actor",
                    "modelId":"creality-k1c-2025",
                    "host":"127.0.0.1:7125",
                    "defaultPort":7125,
                    "firmwareSignature":null,
                    "capabilitiesHint":null
                },
                "apiKey":null
            }),
        );
        assert!(upsert.ok, "{:?}", upsert.error);
        let runtime = call(&endpoint, EngineCommand::RuntimeSnapshot);
        assert!(runtime.ok, "{:?}", runtime.error);
        assert!(runtime
            .data
            .as_ref()
            .is_some_and(|value| value.get("databaseWriter").is_some()));
        // Keep one accepted client alive across shutdown. Windows must not
        // attempt to unlink e.sock until this LocalStream and its server-side
        // connection task have both released their socket handles.
        let held_stream = LocalStream::connect(&endpoint.endpoint).unwrap();
        std::thread::sleep(Duration::from_millis(75));
        let held_stream_release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held_stream);
        });
        assert!(call(&endpoint, EngineCommand::Shutdown).ok);
        worker.join().unwrap().unwrap();
        held_stream_release.join().unwrap();
        assert!(!endpoint_path.exists());
        assert!(
            !Path::new(&endpoint.endpoint).exists(),
            "daemon socket survived listener shutdown"
        );

        let restart_dir = data_dir.clone();
        let (restart_sender, restart_receiver) = std::sync::mpsc::sync_channel(1);
        let restart_worker = std::thread::spawn(move || {
            let result = run_from_args([
                OsString::from("klipper-farmd"),
                OsString::from("--data-dir"),
                restart_dir.into_os_string(),
            ]);
            let _ = restart_sender.send(result.clone());
            result
        });
        let mut restarted_endpoint = None;
        for _ in 0..400 {
            restarted_endpoint = fs::read_to_string(&endpoint_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<EndpointRecord>(&raw).ok());
            if restarted_endpoint.is_some() {
                break;
            }
            if let Ok(result) = restart_receiver.try_recv() {
                panic!("restarted daemon exited before publishing endpoint: {result:?}");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let restarted_endpoint = restarted_endpoint.expect("restarted daemon endpoint");
        let restored = call(&restarted_endpoint, EngineCommand::ActorList);
        assert!(restored.ok, "{:?}", restored.error);
        let restored = restored.data.unwrap().as_array().cloned().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(
            restored[0].get("stableId").and_then(Value::as_str),
            Some("runtime-restart-actor")
        );
        assert_eq!(
            restored[0].get("printerId").and_then(Value::as_str),
            Some("printer-restart-actor")
        );
        assert_eq!(
            restored[0].get("host").and_then(Value::as_str),
            Some("127.0.0.1:7125")
        );
        let health = call(&restarted_endpoint, EngineCommand::Health);
        assert!(health.ok, "{:?}", health.error);
        assert_eq!(
            health
                .data
                .as_ref()
                .and_then(|value| value.get("actorsBootstrapped"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert!(call(&restarted_endpoint, EngineCommand::Shutdown).ok);
        restart_worker.join().unwrap().unwrap();
        let _ = fs::remove_dir_all(data_dir);
    }
}
