use kf_domain::RequestId;
use kf_ipc::{EndpointRecord, EngineCommand, EngineRequest, EngineResponse, MAX_FRAME_BYTES};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

#[cfg(unix)]
use std::os::unix::net::UnixStream as LocalStream;
#[cfg(windows)]
use uds_windows::UnixStream as LocalStream;

const ENDPOINT_FILENAME: &str = "klipper-farmd.endpoint.json";
pub(crate) const IPC_TIMEOUT: Duration = Duration::from_secs(10);
// A fresh install or a just-updated build starts while the OS is under peak
// load (Defender first scans, WebView warmup, component verification). The
// daemon has been observed to need well over 30 seconds to publish its
// endpoint on such hosts, which used to kill it and leave the UI on the
// embedded fallback with an empty printer list. Give the daemon a five-minute
// window per launch attempt and let the startup worker retry the whole launch
// a bounded number of times before settling as Failed.
const STARTUP_ATTEMPTS: usize = 6000;
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(50);
const STARTUP_WAIT_TIMEOUT: Duration = Duration::from_secs(330);
const STARTUP_BACKGROUND_RETRIES: usize = 2;
const STARTUP_BACKGROUND_RETRY_INTERVAL: Duration = Duration::from_secs(10);
const DAEMON_RETIRE_ATTEMPTS: usize = 240;
const DAEMON_RETIRE_POLL_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(windows)]
const WINDOWS_MUTEX_RELEASE_ATTEMPTS: usize = 240;
#[cfg(windows)]
const WINDOWS_MUTEX_RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(25);
const ENGINE_STATUS_EVENT: &str = "klipper-farm-engine-status";
const STARTUP_LOG_TAIL_BYTES: u64 = 16 * 1024;
const STARTUP_ERROR_DETAIL_CHARS: usize = 600;
#[cfg(windows)]
const WINDOWS_DAEMON_IMAGE_NAMES: [&str; 3] = [
    "klipper-farmd.exe",
    "klipper-farmd-x86_64-pc-windows-msvc.exe",
    "klipper-farmd-x86_64-pc-windows-gnu.exe",
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum StartupState {
    Idle,
    Starting,
    Ready,
    EmbeddedFallback(String),
    Failed(String),
}

struct StartupCoordinator {
    state: Mutex<StartupState>,
    changed: Notify,
}

impl Default for StartupCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(StartupState::Idle),
            changed: Notify::new(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct EngineClient {
    endpoint_path: Arc<RwLock<Option<PathBuf>>>,
    recovery_lock: Arc<Mutex<()>>,
    startup: Arc<StartupCoordinator>,
    spawned_daemon: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    #[cfg(windows)]
    daemon_job: Arc<Mutex<Option<crate::desktop_job::DesktopJob>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineStatusSnapshot {
    status: &'static str,
    error: Option<String>,
}

impl Default for EngineClient {
    fn default() -> Self {
        Self {
            endpoint_path: Arc::new(RwLock::new(None)),
            recovery_lock: Arc::new(Mutex::new(())),
            startup: Arc::new(StartupCoordinator::default()),
            spawned_daemon: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
            #[cfg(windows)]
            daemon_job: Arc::new(Mutex::new(None)),
        }
    }
}

impl Drop for EngineClient {
    fn drop(&mut self) {
        // Only the final shared client owns process teardown. Earlier clones
        // are short-lived request workers and must never stop the daemon.
        if Arc::strong_count(&self.spawned_daemon) == 1 {
            self.shutdown();
        }
    }
}

impl EngineClient {
    fn ensure_running(&self) -> Result<(), String> {
        if self.stopping.load(Ordering::SeqCst) { Err("HEADLESS_ENGINE_STOPPING".into()) } else { Ok(()) }
    }

    pub(crate) fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) { return; }
        self.startup.changed.notify_waiters();
        self.shutdown_owned_daemon();
        #[cfg(windows)]
        if let Ok(mut job) = self.daemon_job.lock() { job.take(); }
    }

    pub(crate) fn initialize_background(app: AppHandle) {
        // Mark startup before the worker is spawned.  The WebView can begin
        // invoking commands immediately after setup returns; without this
        // gate, printer_actor_upsert may try to start the embedded core while
        // the just-spawned daemon already owns the Windows engine mutex but has
        // not published its endpoint yet.
        let client = app.state::<Self>().inner().clone();
        client.set_startup_state(StartupState::Starting);
        tauri::async_runtime::spawn_blocking(move || {
            let mut result = client.initialize(&app);
            for attempt in 1..=STARTUP_BACKGROUND_RETRIES {
                match &result {
                    Ok(()) => break,
                    Err(error) => {
                        let error = error.clone();
                        if client.stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        crate::observability::record(
                            "warn",
                            "desktop_startup",
                            "HEADLESS_ENGINE_START_RETRY",
                            None,
                            "Фоновое ядро не поднялось с первой попытки; выполняется повторная попытка запуска",
                            serde_json::json!({"attempt":attempt,"maxAttempts":STARTUP_BACKGROUND_RETRIES + 1,"error":error}),
                        );
                        std::thread::sleep(STARTUP_BACKGROUND_RETRY_INTERVAL);
                        if client.stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        result = client.initialize(&app);
                    }
                }
            }
            let (status, error) = match result {
                Ok(()) => {
                    client.set_startup_state(StartupState::Ready);
                    ("ready", None)
                }
                Err(error) => {
                    client.set_startup_state(StartupState::Failed(error.clone()));
                    crate::observability::record(
                        "error",
                        "desktop_startup",
                        "HEADLESS_ENGINE_START_FAILED",
                        None,
                        "Интерфейс запущен, но фоновое ядро не подключилось",
                        serde_json::json!({"error":error}),
                    );
                    ("degraded", Some(error))
                }
            };
            let _ = app.emit(
                ENGINE_STATUS_EVENT,
                serde_json::json!({"status":status,"error":error}),
            );
        });
    }

    fn set_startup_state(&self, state: StartupState) {
        if let Ok(mut current) = self.startup.state.lock() {
            *current = state;
            self.startup.changed.notify_waiters();
        }
    }

    fn startup_state(&self) -> Result<StartupState, String> {
        self.startup
            .state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "ENGINE_STARTUP_STATE_POISONED".into())
    }

    pub(crate) fn status_snapshot(&self) -> Result<EngineStatusSnapshot, String> {
        let (status, error) = match self.startup_state()? {
            StartupState::Idle => ("idle", None),
            StartupState::Starting => ("starting", None),
            StartupState::Ready => ("ready", None),
            StartupState::EmbeddedFallback(error) => ("embeddedFallback", Some(error)),
            StartupState::Failed(error) => ("failed", Some(error)),
        };
        Ok(EngineStatusSnapshot { status, error })
    }

    pub(crate) fn ensure_embedded_initialization_allowed(&self) -> Result<(), String> {
        self.ensure_running()?;
        match self.startup_state()? {
            StartupState::Starting => Err(
                "HEADLESS_ENGINE_STARTING: desktop compatibility core must wait for daemon startup"
                    .into(),
            ),
            StartupState::Ready => Err(
                "HEADLESS_ENGINE_ACTIVE: klipper-farmd owns the desktop engine lifecycle".into(),
            ),
            StartupState::Idle
            | StartupState::EmbeddedFallback(_)
            | StartupState::Failed(_) => Ok(()),
        }
    }

    pub(crate) async fn wait_for_background_startup(&self) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + STARTUP_WAIT_TIMEOUT;
        loop {
            // Register the waiter before reading the state so a transition
            // between the read and await cannot be lost.
            let changed = self.startup.changed.notified();
            self.ensure_running()?;
            match self.startup_state()? {
                StartupState::Ready => return Ok(()),
                StartupState::Failed(error) => {
                    return Err(format!("HEADLESS_ENGINE_START_FAILED: {error}"))
                }
                StartupState::EmbeddedFallback(error) => {
                    return Err(format!("HEADLESS_ENGINE_EMBEDDED_FALLBACK: {error}"))
                }
                StartupState::Idle => return Err("HEADLESS_ENGINE_NOT_STARTED".into()),
                StartupState::Starting => {}
            }
            tokio::time::timeout_at(deadline, changed)
                .await
                .map_err(|_| "HEADLESS_ENGINE_START_TIMEOUT".to_string())?;
        }
    }

    pub(crate) async fn route_to_daemon(&self) -> Result<bool, String> {
        self.ensure_running()?;
        if matches!(self.startup_state()?, StartupState::EmbeddedFallback(_)) {
            return Ok(false);
        }
        match self.wait_for_background_startup().await {
            Ok(()) => Ok(true),
            Err(startup_error) => {
                // A failed sidecar must not disable every Moonraker endpoint.
                // Re-probe once in case an external/late daemon published its
                // endpoint after the startup decision. If no daemon owns a
                // healthy endpoint and our child is gone, the embedded core is
                // allowed to acquire the same OS engine lease. The lease is the
                // final single-owner guard, so this cannot create two engines.
                let client = self.clone();
                let daemon_ready =
                    crate::transactional_core::engine_runtime::spawn_blocking(
                        crate::transactional_core::engine_runtime::ExecutionClass::Control,
                        move || client.attach_healthy_daemon_or_allow_fallback(),
                    )
                    .await
                    .map_err(|error| format!("HEADLESS_ENGINE_FAILOVER_WORKER_FAILED: {error}"))??;
                if daemon_ready {
                    return Ok(true);
                }
                self.set_startup_state(StartupState::EmbeddedFallback(startup_error.clone()));
                crate::observability::record(
                    "warn",
                    "desktop_startup",
                    "HEADLESS_ENGINE_EMBEDDED_FAILOVER",
                    None,
                    "klipper-farmd недоступен; выбран встроенный движок с тем же single-owner lease",
                    serde_json::json!({"startupError":startup_error}),
                );
                Ok(false)
            }
        }
    }

    fn attach_healthy_daemon_or_allow_fallback(&self) -> Result<bool, String> {
        self.ensure_running()?;
        let endpoint_path = self
            .endpoint_path
            .read()
            .map_err(|_| "ENGINE_CLIENT_STATE_POISONED")?
            .clone();
        if let Some(endpoint_path) = endpoint_path {
            if self.probe_path(&endpoint_path).is_ok()
                && call_path(&endpoint_path, EngineCommand::Negotiate, Value::Null).is_ok()
            {
                self.set_startup_state(StartupState::Ready);
                return Ok(true);
            }
        }
        if self.spawned_daemon_running()? {
            // The startup worker has already settled as Failed, so a child
            // that is still alive without an authenticated endpoint is owned
            // by this client but unusable. Terminate only that tracked child;
            // never target an arbitrary PID read from disk.
            self.stop_spawned_daemon()?;
            if let Some(endpoint_path) = self
                .endpoint_path
                .read()
                .map_err(|_| "ENGINE_CLIENT_STATE_POISONED")?
                .clone()
            {
                if self.probe_path(&endpoint_path).is_ok()
                    && call_path(&endpoint_path, EngineCommand::Negotiate, Value::Null).is_ok()
                {
                    self.set_startup_state(StartupState::Ready);
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub(crate) async fn call_async<T: DeserializeOwned + Send + 'static>(
        &self,
        class: crate::transactional_core::engine_runtime::ExecutionClass,
        command: EngineCommand,
        payload: Value,
    ) -> Result<T, String> {
        self.wait_for_background_startup().await?;
        let client = self.clone();
        crate::transactional_core::engine_runtime::spawn_blocking(class, move || {
            client.call(command, payload)
        })
        .await
        .map_err(|error| format!("HEADLESS_ENGINE_IPC_WORKER_FAILED: {error}"))?
    }

    pub(crate) fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        self.ensure_running()?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        crate::set_private_directory_permissions(&data_dir)?;
        let endpoint_path = data_dir.join(ENDPOINT_FILENAME);
        *self
            .endpoint_path
            .write()
            .map_err(|_| "ENGINE_CLIENT_STATE_POISONED")? = Some(endpoint_path.clone());
        // A clean desktop exit now shuts down its child, but FIX3.10 must also
        // replace an authenticated daemon left by an older installed build.
        // The endpoint token proves that this is our app-data daemon; no
        // arbitrary PID from disk is ever terminated. Restarting it here also
        // guarantees that desktop and sidecar contain the same fixes.
        let authenticated_daemon_retired = self.retire_authenticated_daemon(&endpoint_path)?;
        if self.probe_path(&endpoint_path).is_err() {
            self.start_daemon_until_ready(
                &data_dir,
                &endpoint_path,
                !authenticated_daemon_retired,
            )?;
        }
        if let Err(error) = self.call::<Value>(EngineCommand::Negotiate, Value::Null) {
            self.stop_spawned_daemon()?;
            return Err(error);
        }
        Ok(())
    }

    fn start_daemon(&self, data_dir: &Path) -> Result<(), String> {
        // Serialize spawn with shutdown, including the initial startup worker.
        let mut current = self.spawned_daemon.lock().map_err(|_| "ENGINE_CHILD_STATE_POISONED")?;
        self.ensure_running()?;
        #[cfg(windows)]
        let mut job = self.daemon_job.lock().map_err(|_| "ENGINE_JOB_STATE_POISONED")?;
        #[cfg(windows)]
        if job.is_none() { *job = Some(crate::desktop_job::DesktopJob::new()?); }
        let mut child = spawn_daemon(data_dir)?;
        #[cfg(windows)]
        if let Err(error) = job.as_ref().ok_or("ENGINE_JOB_MISSING")?.attach(&child) {
            let _ = child.kill(); let _ = child.wait(); return Err(error);
        }
        if self.stopping.load(Ordering::SeqCst) {
            let _ = child.kill(); let _ = child.wait(); return Err("HEADLESS_ENGINE_STOPPING".into());
        }
        *current = Some(child);
        Ok(())
    }

    fn start_daemon_until_ready(
        &self,
        data_dir: &Path,
        endpoint_path: &Path,
        retire_unreachable_owner: bool,
    ) -> Result<(), String> {
        self.ensure_running()?;
        #[cfg(not(windows))]
        let _ = retire_unreachable_owner;
        #[cfg(windows)]
        if retire_unreachable_owner {
            self.retire_unreachable_windows_owner(data_dir)?;
        }

        let launch_attempts = if cfg!(windows) { 2 } else { 1 };
        for _launch_attempt in 0..launch_attempts {
            self.start_daemon(data_dir)?;
            let mut retry_owner_conflict = false;
            for _ in 0..STARTUP_ATTEMPTS {
                self.ensure_running()?;
                if self.probe_path(endpoint_path).is_ok() {
                    return Ok(());
                }
                if let Some(status) = self.spawned_daemon_exit_status()? {
                    let error = daemon_exit_error(status, data_dir);
                    #[cfg(windows)]
                    if _launch_attempt == 0 && engine_owner_conflict(&error) {
                        // The owner may have appeared between the preflight
                        // and spawn, or taskkill may have returned while its
                        // final mutex handle was still closing. Perform one
                        // bounded verified takeover and retry exactly once.
                        self.retire_unreachable_windows_owner(data_dir)?;
                        retry_owner_conflict = true;
                        break;
                    }
                    return Err(error);
                }
                std::thread::sleep(STARTUP_POLL_INTERVAL);
            }
            if retry_owner_conflict {
                continue;
            }
            if let Some(status) = self.spawned_daemon_exit_status()? {
                return Err(daemon_exit_error(status, data_dir));
            }
            self.stop_spawned_daemon()?;
            return Err(startup_error_with_detail(
                "HEADLESS_ENGINE_START_TIMEOUT".into(),
                data_dir,
            ));
        }
        Err(startup_error_with_detail(
            "HEADLESS_ENGINE_OWNER_RECOVERY_EXHAUSTED".into(),
            data_dir,
        ))
    }

    #[cfg(windows)]
    fn retire_unreachable_windows_owner(&self, data_dir: &Path) -> Result<(), String> {
        let mut retired = retire_known_windows_daemon_images()?;
        if retire_recorded_windows_daemon(data_dir)? {
            retired += 1;
        }
        if retired > 0 {
            crate::observability::record(
                "warn",
                "desktop_startup",
                "STALE_DAEMON_IMAGE_RETIRED",
                None,
                "Недоступный klipper-farmd предыдущего запуска завершён перед controlled takeover",
                serde_json::json!({"retiredImages":retired}),
            );
        }
        wait_for_windows_engine_owner_release(retired)
    }

    fn retire_authenticated_daemon(&self, endpoint_path: &Path) -> Result<bool, String> {
        if !endpoint_path.exists()
            || call_path(endpoint_path, EngineCommand::Shutdown, Value::Null).is_err()
        {
            return Ok(false);
        }
        for _ in 0..DAEMON_RETIRE_ATTEMPTS {
            if !endpoint_path.exists() {
                return Ok(true);
            }
            std::thread::sleep(DAEMON_RETIRE_POLL_INTERVAL);
        }
        Err("HEADLESS_ENGINE_PREVIOUS_DAEMON_SHUTDOWN_TIMEOUT".into())
    }

    fn shutdown_owned_daemon(&self) {
        let owned = self
            .spawned_daemon
            .lock()
            .map(|child| child.is_some())
            .unwrap_or(false);
        if !owned {
            return;
        }
        if let Ok(endpoint_path) = self.endpoint_path.read() {
            if let Some(endpoint_path) = endpoint_path.as_deref() {
                let _ = call_path(endpoint_path, EngineCommand::Shutdown, Value::Null);
            }
        }
        for _ in 0..DAEMON_RETIRE_ATTEMPTS {
            match self.spawned_daemon_running() {
                Ok(false) => return,
                Ok(true) => std::thread::sleep(DAEMON_RETIRE_POLL_INTERVAL),
                Err(_) => break,
            }
        }
        // The fallback only touches the Child handle spawned by this client.
        let _ = self.stop_spawned_daemon();
    }

    fn spawned_daemon_exit_status(&self) -> Result<Option<std::process::ExitStatus>, String> {
        let mut current = self
            .spawned_daemon
            .lock()
            .map_err(|_| "ENGINE_CHILD_STATE_POISONED")?;
        let Some(child) = current.as_mut() else {
            return Ok(None);
        };
        let status = child.try_wait().map_err(|error| error.to_string())?;
        if status.is_some() {
            *current = None;
        }
        Ok(status)
    }

    fn spawned_daemon_running(&self) -> Result<bool, String> {
        let mut current = self
            .spawned_daemon
            .lock()
            .map_err(|_| "ENGINE_CHILD_STATE_POISONED")?;
        let Some(child) = current.as_mut() else {
            return Ok(false);
        };
        match child.try_wait().map_err(|error| error.to_string())? {
            None => Ok(true),
            Some(_) => {
                *current = None;
                Ok(false)
            }
        }
    }

    fn stop_spawned_daemon(&self) -> Result<(), String> {
        let mut current = self
            .spawned_daemon
            .lock()
            .map_err(|_| "ENGINE_CHILD_STATE_POISONED")?;
        let Some(mut child) = current.take() else {
            return Ok(());
        };
        if child.try_wait().map_err(|error| error.to_string())?.is_none() {
            if let Err(kill_error) = child.kill() {
                if child.try_wait().map_err(|error| error.to_string())?.is_none() {
                    return Err(format!(
                        "HEADLESS_ENGINE_TERMINATE_FAILED: {kill_error}"
                    ));
                }
            }
            child
                .wait()
                .map_err(|error| format!("HEADLESS_ENGINE_WAIT_FAILED: {error}"))?;
        }
        Ok(())
    }

    pub(crate) fn call<T: DeserializeOwned>(
        &self,
        command: EngineCommand,
        payload: Value,
    ) -> Result<T, String> {
        self.ensure_running()?;
        let endpoint_path = self
            .endpoint_path
            .read()
            .map_err(|_| "ENGINE_CLIENT_STATE_POISONED")?
            .clone()
            .ok_or("HEADLESS_ENGINE_NOT_INITIALIZED")?;
        let response = match call_path(&endpoint_path, command, payload.clone()) {
            Ok(response) => response,
            Err(error) if engine_transport_recoverable(&error) => {
                self.recover(&endpoint_path)?;
                if !engine_command_retry_safe(command) {
                    return Err(format!(
                        "HEADLESS_ENGINE_RECOVERED_RETRY_REQUIRED: команда не повторена после неопределённого результата; {error}"
                    ));
                }
                call_path(&endpoint_path, command, payload)?
            }
            Err(error) => return Err(error),
        };
        let data = response.data.unwrap_or(Value::Null);
        serde_json::from_value(data).map_err(|error| format!("IPC_RESPONSE_SCHEMA: {error}"))
    }

    fn recover(&self, endpoint_path: &Path) -> Result<(), String> {
        self.ensure_running()?;
        let _guard = self
            .recovery_lock
            .lock()
            .map_err(|_| "ENGINE_RECOVERY_STATE_POISONED")?;
        self.ensure_running()?;
        if self.probe_path(endpoint_path).is_ok() {
            return Ok(());
        }
        let data_dir = endpoint_path
            .parent()
            .ok_or("ENGINE_ENDPOINT_HAS_NO_PARENT")?;
        self.set_startup_state(StartupState::Starting);
        if !self.spawned_daemon_running()? {
            let result = self.start_daemon_until_ready(data_dir, endpoint_path, true);
            match result {
                Ok(()) => {
                    self.set_startup_state(StartupState::Ready);
                    return Ok(());
                }
                Err(error) => {
                    self.set_startup_state(StartupState::Failed(error.clone()));
                    return Err(error);
                }
            }
        }
        for _ in 0..STARTUP_ATTEMPTS {
            self.ensure_running()?;
            if self.probe_path(endpoint_path).is_ok() {
                self.set_startup_state(StartupState::Ready);
                return Ok(());
            }
            if let Some(status) = self.spawned_daemon_exit_status()? {
                let error = daemon_exit_error(status, data_dir);
                #[cfg(windows)]
                if engine_owner_conflict(&error) {
                    let result = self.start_daemon_until_ready(data_dir, endpoint_path, true);
                    match result {
                        Ok(()) => {
                            self.set_startup_state(StartupState::Ready);
                            return Ok(());
                        }
                        Err(recovery_error) => {
                            self.set_startup_state(StartupState::Failed(recovery_error.clone()));
                            return Err(recovery_error);
                        }
                    }
                }
                self.set_startup_state(StartupState::Failed(error.clone()));
                return Err(error);
            }
            std::thread::sleep(STARTUP_POLL_INTERVAL);
        }
        self.stop_spawned_daemon()?;
        let result = self.start_daemon_until_ready(data_dir, endpoint_path, true);
        match result {
            Ok(()) => {
                self.set_startup_state(StartupState::Ready);
                Ok(())
            }
            Err(restart_error) => {
                let error = format!(
                    "HEADLESS_ENGINE_RECOVERY_TIMEOUT; restart failed: {restart_error}"
                );
                self.set_startup_state(StartupState::Failed(error.clone()));
                Err(error)
            }
        }
    }

    fn probe_path(&self, endpoint_path: &Path) -> Result<Value, String> {
        let response = call_path(endpoint_path, EngineCommand::Health, Value::Null)?;
        response.data.ok_or("IPC_HEALTH_EMPTY".into())
    }
}

fn engine_transport_recoverable(error: &str) -> bool {
    [
        "IPC_CONNECT:",
        "IPC_READ_HEADER:",
        "IPC_READ_BODY:",
        "IPC_WRITE_HEADER:",
        "IPC_WRITE_BODY:",
        "IPC_ENDPOINT_SCHEMA:",
        "IPC_ENDPOINT_INCOMPATIBLE",
        "IPC_BAD_RESPONSE:",
        "IPC_RESPONSE_TOO_LARGE",
        "IPC_RESPONSE_REQUEST_ID_MISMATCH",
        "No such file or directory",
        "os error 2",
        "os error 3",
        "os error 109",
        "os error 232",
        "os error 233",
    ]
    .iter()
    .any(|marker| error.contains(marker))
}

fn engine_owner_conflict(error: &str) -> bool {
    error.contains("ENGINE_ALREADY_RUNNING") || error.contains("HEADLESS_ENGINE_ACTIVE")
}

fn engine_command_retry_safe(command: EngineCommand) -> bool {
    matches!(
        command,
        EngineCommand::Negotiate
            | EngineCommand::Health
            | EngineCommand::RuntimeSnapshot
            | EngineCommand::ActorList
            | EngineCommand::ActorUpsert
            | EngineCommand::PendingEvents
            | EngineCommand::AcknowledgeEvents
            | EngineCommand::DatabaseSnapshot
            | EngineCommand::ListOperations
            | EngineCommand::SchedulerSnapshot
            | EngineCommand::ListFarmJobs
            | EngineCommand::FarmJobEvents
            | EngineCommand::UploadList
            | EngineCommand::WorkflowList
    )
}

fn command_response_timeout(command: EngineCommand) -> Duration {
    match command {
        // UploadFinish waits synchronously for the actor background task. A
        // generic ten-second read deadline used to abort a healthy transfer.
        EngineCommand::UploadFinish => {
            crate::transactional_core::BACKGROUND_RESPONSE_TIMEOUT + IPC_TIMEOUT
        }
        _ => IPC_TIMEOUT,
    }
}

fn call_path(
    endpoint_path: &Path,
    command: EngineCommand,
    payload: Value,
) -> Result<EngineResponse, String> {
    let request_id = RequestId::parse(hex::encode(crate::random_bytes::<16>()?))
        .map_err(|error| error.to_string())?;
    call_path_with_request_id(endpoint_path, command, payload, request_id)
}

pub(crate) fn call_path_with_request_id(
    endpoint_path: &Path,
    command: EngineCommand,
    payload: Value,
    request_id: RequestId,
) -> Result<EngineResponse, String> {
    let raw = fs::read_to_string(endpoint_path).map_err(|error| error.to_string())?;
    let endpoint: EndpointRecord =
        serde_json::from_str(&raw).map_err(|error| format!("IPC_ENDPOINT_SCHEMA: {error}"))?;
    if endpoint.protocol_version < kf_ipc::MIN_COMPATIBLE_VERSION
        || endpoint.minimum_client_version > kf_ipc::PROTOCOL_VERSION
        || endpoint.transport != "local_socket"
        || endpoint.endpoint.is_empty()
    {
        return Err("IPC_ENDPOINT_INCOMPATIBLE".into());
    }
    let request = EngineRequest {
        protocol_version: kf_ipc::PROTOCOL_VERSION,
        request_id: request_id.clone(),
        token: endpoint.token,
        command,
        payload,
    };
    let payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err("IPC_REQUEST_TOO_LARGE".into());
    }
    let mut stream = LocalStream::connect(&endpoint.endpoint)
        .map_err(|error| format!("IPC_CONNECT: {error}"))?;
    stream
        .set_read_timeout(Some(command_response_timeout(command)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(IPC_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .map_err(|error| format!("IPC_WRITE_HEADER: {error}"))?;
    stream
        .write_all(&payload)
        .map_err(|error| format!("IPC_WRITE_BODY: {error}"))?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("IPC_READ_HEADER: {error}"))?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err("IPC_RESPONSE_TOO_LARGE".into());
    }
    let mut body = vec![0_u8; size];
    stream
        .read_exact(&mut body)
        .map_err(|error| format!("IPC_READ_BODY: {error}"))?;
    let response: EngineResponse =
        serde_json::from_slice(&body).map_err(|error| format!("IPC_BAD_RESPONSE: {error}"))?;
    if response.request_id != request_id {
        return Err("IPC_RESPONSE_REQUEST_ID_MISMATCH".into());
    }
    if !response.ok {
        let code = response
            .error_detail
            .as_ref()
            .map(|detail| detail.code.as_str())
            .unwrap_or("IPC_REMOTE_ERROR");
        return Err(format!(
            "{code}: {}",
            response.error.as_deref().unwrap_or("Headless engine error")
        ));
    }
    Ok(response)
}

fn spawn_daemon(data_dir: &Path) -> Result<Child, String> {
    let executable = daemon_executable()?;
    let log_path = data_dir.join("klipper-farmd.startup.log");
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|error| format!("HEADLESS_ENGINE_LOG_OPEN_FAILED: {error}"))?;
    crate::set_private_file_permissions(&log_path)?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("HEADLESS_ENGINE_LOG_CLONE_FAILED: {error}"))?;
    let mut command = Command::new(&executable);
    command
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|error| {
        format!(
            "HEADLESS_ENGINE_SPAWN_FAILED {}: {error}",
            executable.display()
        )
    })
}

#[cfg(windows)]
fn retire_known_windows_daemon_images() -> Result<usize, String> {
    let taskkill = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("taskkill.exe"))
        .filter(|path| path.is_file())
        .ok_or("HEADLESS_ENGINE_TASKKILL_NOT_FOUND")?;
    let mut retired = 0;
    for image_name in WINDOWS_DAEMON_IMAGE_NAMES {
        let mut command = Command::new(&taskkill);
        command
            .args(["/F", "/T", "/IM", image_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        match command.status() {
            Ok(status) if status.success() => retired += 1,
            // Windows ERROR_WAIT_NO_CHILDREN (128) is taskkill's normal
            // "image not found" result. Access denied and every other code
            // are real takeover failures and remain visible to the user.
            Ok(status) if status.code() == Some(128) => {}
            Ok(status) => {
                return Err(format!(
                    "HEADLESS_ENGINE_STALE_DAEMON_RETIRE_FAILED {image_name}: exit code {}",
                    status.code().unwrap_or(-1)
                ))
            }
            Err(error) => {
                return Err(format!(
                    "HEADLESS_ENGINE_STALE_DAEMON_RETIRE_FAILED {image_name}: {error}"
                ))
            }
        }
    }
    Ok(retired)
}

#[cfg(windows)]
fn retire_recorded_windows_daemon(data_dir: &Path) -> Result<bool, String> {
    let Some(record) = crate::transactional_core::engine_lease::production_owner_record(data_dir)?
    else {
        return Ok(false);
    };
    if record.owner != "headless"
        || record.pid == 0
        || record.pid == std::process::id()
        || record.acquired_at <= 0
        || record.acquired_at > crate::now_ms() + 300_000
    {
        return Ok(false);
    }

    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32"))
        .ok_or("HEADLESS_ENGINE_WINDOWS_SYSTEM32_NOT_FOUND")?;
    let tasklist = system32.join("tasklist.exe");
    let taskkill = system32.join("taskkill.exe");
    if !tasklist.is_file() || !taskkill.is_file() {
        return Err("HEADLESS_ENGINE_WINDOWS_PROCESS_TOOLS_NOT_FOUND".into());
    }

    let pid_filter = format!("PID eq {}", record.pid);
    let mut inspect = Command::new(&tasklist);
    inspect
        .args(["/FI", &pid_filter, "/FO", "CSV", "/NH"])
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let output = inspect
        .output()
        .map_err(|error| format!("HEADLESS_ENGINE_OWNER_INSPECTION_FAILED: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "HEADLESS_ENGINE_OWNER_INSPECTION_FAILED: exit code {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let Some(image_name) = listing.lines().find_map(parse_tasklist_image_name) else {
        return Ok(false);
    };
    if !trusted_daemon_image_name(&image_name) {
        return Ok(false);
    }

    let pid = record.pid.to_string();
    let mut terminate = Command::new(&taskkill);
    terminate
        .args(["/F", "/T", "/PID", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    match terminate.status() {
        Ok(status) if status.success() => {
            crate::observability::record(
                "warn",
                "desktop_startup",
                "STALE_RECORDED_DAEMON_RETIRED",
                None,
                "Завершён подтверждённый lease-записью klipper-farmd с нестандартным именем образа",
                serde_json::json!({"pid":record.pid,"imageName":image_name}),
            );
            Ok(true)
        }
        Ok(status) if status.code() == Some(128) => Ok(false),
        Ok(status) => Err(format!(
            "HEADLESS_ENGINE_RECORDED_DAEMON_RETIRE_FAILED pid={}: exit code {}",
            record.pid,
            status.code().unwrap_or(-1)
        )),
        Err(error) => Err(format!(
            "HEADLESS_ENGINE_RECORDED_DAEMON_RETIRE_FAILED pid={}: {error}",
            record.pid
        )),
    }
}

#[cfg(windows)]
fn parse_tasklist_image_name(line: &str) -> Option<String> {
    let line = line.trim();
    let quoted = line.strip_prefix('"')?;
    let (image, _) = quoted.split_once("\",\"")?;
    Some(image.to_string())
}

#[cfg(windows)]
fn trusted_daemon_image_name(image_name: &str) -> bool {
    let normalized = image_name.to_ascii_lowercase();
    normalized.starts_with("klipper-farmd")
        && normalized.ends_with(".exe")
        && normalized.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
        })
}

#[cfg(windows)]
fn wait_for_windows_engine_owner_release(retired_images: usize) -> Result<(), String> {
    for _ in 0..WINDOWS_MUTEX_RELEASE_ATTEMPTS {
        if !crate::transactional_core::engine_lease::production_owner_present()? {
            return Ok(());
        }
        std::thread::sleep(WINDOWS_MUTEX_RELEASE_POLL_INTERVAL);
    }
    if retired_images == 0 {
        return Err(
            "HEADLESS_ENGINE_UNIDENTIFIED_OWNER: Windows mutex занят, но ни один известный klipper-farmd не найден"
                .into(),
        );
    }
    Err(format!(
        "HEADLESS_ENGINE_MUTEX_RELEASE_TIMEOUT: завершено образов {retired_images}, но Windows mutex остался занят"
    ))
}

fn daemon_exit_error(status: std::process::ExitStatus, data_dir: &Path) -> String {
    startup_error_with_detail(format!("HEADLESS_ENGINE_EXITED: {status}"), data_dir)
}

fn startup_error_with_detail(base: String, data_dir: &Path) -> String {
    match startup_log_error_detail(data_dir) {
        Some(detail) => format!("{base}; {detail}"),
        None => base,
    }
}

fn startup_log_error_detail(data_dir: &Path) -> Option<String> {
    let path = data_dir.join("klipper-farmd.startup.log");
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(STARTUP_LOG_TAIL_BYTES)))
        .ok()?;
    let mut bytes = Vec::with_capacity(size.min(STARTUP_LOG_TAIL_BYTES) as usize);
    file.read_to_end(&mut bytes).ok()?;
    let raw = String::from_utf8_lossy(&bytes);
    let lines = raw
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let line = lines
        .iter()
        .copied()
        .find(|line| line.contains("klipper-farmd:") || line.contains("panicked at"))
        .or_else(|| lines.first().copied())?;
    sanitize_startup_error_detail(line)
}

fn sanitize_startup_error_detail(raw: &str) -> Option<String> {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let lower = normalized.to_ascii_lowercase();
    // Startup failures should never contain credentials. If a future error
    // accidentally includes a header or key/value secret, keep it in the
    // private diagnostic ZIP and do not pass it to the WebView status banner.
    if [
        "authorization:",
        "authorization=",
        "api_key=",
        "apikey=",
        "access_token=",
        "bearer ",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return Some("klipper-farmd сообщил защищённую диагностическую строку; подробность сохранена в диагностическом ZIP".into());
    }
    Some(
        normalized
            .chars()
            .take(STARTUP_ERROR_DETAIL_CHARS)
            .collect(),
    )
}

fn daemon_executable() -> Result<PathBuf, String> {
    // A release build must run only the sidecar shipped beside the desktop.
    // Keeping the environment override in production would allow an old or
    // arbitrarily named daemon to own the fixed mutex while the bounded
    // takeover deliberately targets only packaged image names.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("KLIPPER_FARMD_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = current.parent().ok_or("CURRENT_EXECUTABLE_HAS_NO_PARENT")?;
    #[cfg(windows)]
    let names = WINDOWS_DAEMON_IMAGE_NAMES;
    #[cfg(not(windows))]
    let names = ["klipper-farmd", "klipper-farmd-x86_64-unknown-linux-gnu"];
    for name in names {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("HEADLESS_ENGINE_BINARY_NOT_FOUND".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_prevents_late_startup_recovery_and_embedded_fallback() {
        let client = EngineClient::default();
        let worker = client.clone();
        client.set_startup_state(StartupState::Starting);
        client.shutdown();
        // A startup/request worker may retain its AppHandle/client after
        // ExitRequested. None of those references may restart an engine.
        assert_eq!(worker.start_daemon(Path::new("unused")).unwrap_err(), "HEADLESS_ENGINE_STOPPING");
        assert_eq!(worker.recover(Path::new("unused")).unwrap_err(), "HEADLESS_ENGINE_STOPPING");
        assert!(worker.ensure_embedded_initialization_allowed().is_err());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        assert_eq!(runtime.block_on(worker.wait_for_background_startup()).unwrap_err(), "HEADLESS_ENGINE_STOPPING");
        assert_eq!(runtime.block_on(worker.route_to_daemon()).unwrap_err(), "HEADLESS_ENGINE_STOPPING");
        client.shutdown(); // ExitRequested, Exit and Drop can all call this.
    }

    #[test]
    fn upload_finish_waits_past_short_ipc_deadline_without_replay() {
        #[cfg(unix)]
        use std::os::unix::net::UnixListener as LocalListener;
        #[cfg(windows)]
        use uds_windows::UnixListener as LocalListener;

        let directory = std::env::temp_dir().join(format!(
            "kf-slow-{}-{}",
            std::process::id(),
            hex::encode(crate::random_bytes::<4>().unwrap())
        ));
        fs::create_dir_all(&directory).unwrap();
        let socket = directory.join("ipc.sock");
        let listener = LocalListener::bind(&socket).unwrap();
        let endpoint_path = directory.join("endpoint.json");
        let endpoint = EndpointRecord {
            protocol_version: kf_ipc::PROTOCOL_VERSION,
            minimum_client_version: kf_ipc::MIN_COMPATIBLE_VERSION,
            pid: std::process::id(),
            transport: "local_socket".into(),
            endpoint: socket.to_string_lossy().into_owned(),
            token: "ab".repeat(32),
            token_generation: 1,
            started_at: 1,
        };
        fs::write(&endpoint_path, serde_json::to_vec(&endpoint).unwrap()).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(IPC_TIMEOUT)).unwrap();
            stream.set_write_timeout(Some(IPC_TIMEOUT)).unwrap();
            let mut header = [0_u8; 4];
            stream.read_exact(&mut header).unwrap();
            let mut body = vec![0_u8; u32::from_be_bytes(header) as usize];
            stream.read_exact(&mut body).unwrap();
            let request: EngineRequest = serde_json::from_slice(&body).unwrap();
            assert_eq!(request.command, EngineCommand::UploadFinish);
            assert_eq!(request.payload["uploadId"], "neutral-test-upload");
            // A real socket response arrives beyond the old ten-second limit.
            std::thread::sleep(IPC_TIMEOUT + Duration::from_secs(2));
            let response = EngineResponse {
                protocol_version: kf_ipc::PROTOCOL_VERSION,
                request_id: request.request_id,
                ok: true,
                data: Some(serde_json::json!({"receipt":"completed-once"})),
                error: None,
                error_detail: None,
            };
            let body = serde_json::to_vec(&response).unwrap();
            stream.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
            stream.write_all(&body).unwrap();
            stream.flush().unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(listener.accept().is_err(), "request was replayed");
        });
        let client = EngineClient::default();
        *client.endpoint_path.write().unwrap() = Some(endpoint_path);
        let result = client.call::<Value>(
            EngineCommand::UploadFinish,
            serde_json::json!({"uploadId":"neutral-test-upload"}),
        );
        worker.join().unwrap();
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(result.unwrap()["receipt"], "completed-once");
        assert_eq!(command_response_timeout(EngineCommand::Health), IPC_TIMEOUT);
        assert_eq!(command_response_timeout(EngineCommand::UploadAbort), IPC_TIMEOUT);
        assert!(!engine_command_retry_safe(EngineCommand::UploadFinish));
    }

    #[test]
    fn endpoint_contract_rejects_network_transports() {
        let endpoint = EndpointRecord {
            protocol_version: kf_ipc::PROTOCOL_VERSION,
            minimum_client_version: kf_ipc::MIN_COMPATIBLE_VERSION,
            pid: 1,
            transport: "tcp".into(),
            endpoint: "127.0.0.1:1234".into(),
            token: "00".repeat(32),
            token_generation: 1,
            started_at: 1,
        };
        assert_ne!(endpoint.transport, "local_socket");
    }

    #[test]
    fn only_local_ipc_transport_failures_trigger_daemon_recovery() {
        for error in [
            "IPC_CONNECT: connection refused",
            "IPC_READ_HEADER: pipe has been ended (os error 109)",
            "No such file or directory (os error 2)",
            "IPC_BAD_RESPONSE: EOF while parsing a value",
        ] {
            assert!(engine_transport_recoverable(error), "{error}");
        }
        for error in [
            "IPC_REMOTE_ERROR: Moonraker HTTP error 401",
            "FORBIDDEN: insufficient permissions",
            "PRINTER_QUARANTINED: identity mismatch",
        ] {
            assert!(!engine_transport_recoverable(error), "{error}");
        }

        // Reproduce the desktop/daemon startup race: the WebView command must
        // wait while the daemon owns the named mutex but has not yet published
        // its endpoint.  Returning early here would send the command into the
        // embedded core and surface ENGINE_ALREADY_RUNNING to every printer.
        let client = EngineClient::default();
        client.set_startup_state(StartupState::Starting);
        let release = client.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            release.set_startup_state(StartupState::Ready);
        });
        let started = std::time::Instant::now();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime
            .block_on(client.wait_for_background_startup())
            .unwrap();
        worker.join().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert_eq!(client.startup_state().unwrap(), StartupState::Ready);
    }

    #[test]
    fn settled_startup_failure_allows_single_owner_embedded_failover() {
        let client = EngineClient::default();
        client.set_startup_state(StartupState::Failed("daemon crashed".into()));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        assert!(!runtime.block_on(client.route_to_daemon()).unwrap());
        assert_eq!(
            client.startup_state().unwrap(),
            StartupState::EmbeddedFallback(
                "HEADLESS_ENGINE_START_FAILED: daemon crashed".into()
            )
        );
    }

    #[test]
    fn embedded_core_cannot_race_daemon_startup_or_ready_state() {
        let client = EngineClient::default();
        client.set_startup_state(StartupState::Starting);
        assert!(client
            .ensure_embedded_initialization_allowed()
            .unwrap_err()
            .contains("HEADLESS_ENGINE_STARTING"));
        client.set_startup_state(StartupState::Ready);
        assert!(client
            .ensure_embedded_initialization_allowed()
            .unwrap_err()
            .contains("HEADLESS_ENGINE_ACTIVE"));
        client.set_startup_state(StartupState::Failed("daemon unavailable".into()));
        assert!(client.ensure_embedded_initialization_allowed().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn recorded_daemon_image_parser_accepts_only_product_sidecars() {
        assert_eq!(
            parse_tasklist_image_name(
                "\"klipper-farmd-build-7.exe\",\"4242\",\"Console\",\"1\",\"10,000 K\""
            )
            .as_deref(),
            Some("klipper-farmd-build-7.exe")
        );
        for accepted in [
            "klipper-farmd.exe",
            "klipper-farmd-x86_64-pc-windows-msvc.exe",
            "klipper-farmd-build-7.exe",
        ] {
            assert!(trusted_daemon_image_name(accepted), "{accepted}");
        }
        for rejected in [
            "klipper-farm-client.exe",
            "other-klipper-farmd.exe",
            "klipper-farmd.exe.cmd",
            "klipper-farmd evil.exe",
        ] {
            assert!(!trusted_daemon_image_name(rejected), "{rejected}");
        }
    }

    #[test]
    fn daemon_recovery_retries_only_idempotent_or_read_only_commands() {
        for command in [
            EngineCommand::Health,
            EngineCommand::ActorList,
            EngineCommand::ActorUpsert,
            EngineCommand::PendingEvents,
            EngineCommand::AcknowledgeEvents,
        ] {
            assert!(engine_command_retry_safe(command), "{command:?}");
        }
        for command in [
            EngineCommand::ActorRpc,
            EngineCommand::FarmQueueDispatch,
            EngineCommand::UploadChunk,
            EngineCommand::UploadFinish,
            EngineCommand::RotateToken,
        ] {
            assert!(!engine_command_retry_safe(command), "{command:?}");
        }
    }

    #[test]
    fn owner_conflict_retry_is_narrowly_classified() {
        for error in [
            "HEADLESS_ENGINE_EXITED: exit code: 1; klipper-farmd: ENGINE_ALREADY_RUNNING: Windows named mutex занят",
            "HEADLESS_ENGINE_ACTIVE: authenticated daemon owns the core",
        ] {
            assert!(engine_owner_conflict(error), "{error}");
        }
        for error in [
            "IPC_CONNECT: os error 10054",
            "HEADLESS_ENGINE_BINARY_NOT_FOUND",
            "Moonraker HTTP error 401",
        ] {
            assert!(!engine_owner_conflict(error), "{error}");
        }
    }

    #[test]
    fn startup_error_detail_is_bounded_and_redacts_credentials() {
        let keyring = sanitize_startup_error_detail(
            "klipper-farmd: No default store has been set, so cannot search or create entries",
        )
        .unwrap();
        assert!(keyring.contains("No default store"));
        assert!(keyring.len() <= STARTUP_ERROR_DETAIL_CHARS);

        let bounded = sanitize_startup_error_detail(&"x".repeat(1_000)).unwrap();
        assert_eq!(bounded.chars().count(), STARTUP_ERROR_DETAIL_CHARS);

        let protected = sanitize_startup_error_detail(
            "klipper-farmd: request failed Authorization: Bearer secret-value",
        )
        .unwrap();
        assert!(!protected.contains("secret-value"));
        assert!(protected.contains("диагностическом ZIP"));
    }
}
