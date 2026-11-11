use super::async_websocket::AsyncWebSocket as PersistentWebSocket;
use super::capabilities;
use super::engine_runtime::{EngineRuntime, ExecutionClass};
use super::identity;
use super::journal::{Journal, JournalRecord};
use super::moonraker_transport::{MoonrakerRpcRequest, MoonrakerTransport};
use super::scheduler::FarmScheduler;
use super::state_machine::PrinterStateMachine;
use super::temperature::{core_temperature_observed_at, missing_temperature_objects, observed_temperature};
use super::types::{
    classify_method, ActorConfig, ActorEvent, ActorSnapshot, OperationPriority, OperationRequest, OperationResult,
    OperationState, PrinterPhase, RepeatPolicy,
};
use crate::{now_ms, parse_target, HttpTarget};
use serde_json::Value;
use std::cmp::Ordering as CompareOrdering;
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const ACTOR_EVENT: &str = "printer-actor-event";
// Several vendor Moonraker builds do not emit notifications while values stay
// unchanged.  Reconcile often enough that an otherwise healthy printer never
// crosses the UI's 20 second "stale" boundary solely because it is quiet.
const REST_RECONCILE_INTERVAL: Duration = Duration::from_secs(8);
// Отступ при повторяющихся ошибках REST-опроса. Живая база показала 1200 неудач за одну
// ночь от принтера в сне: опрос шёл каждые 8 секунд без паузы, каждая неудача писалась в
// журнал. Отступ растёт до минуты и сбрасывается первым же успехом.
const REST_RECONCILE_MAX_INTERVAL: Duration = Duration::from_secs(60);
const CONNECTION_STALE_RECONNECT_MS: i64 = 30_000;
const WS_IDLE_SLICE: Duration = Duration::from_millis(180);
const WS_RPC_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(120);
const AUTHORIZATION_RECONNECT_DELAY: Duration = Duration::from_secs(60);
const ACTOR_MAILBOX_CAPACITY: usize = 128;
const MAX_OPERATION_QUEUE: usize = 96;
const MAX_INBOX_BURST: usize = 16;
const POST_COMMAND_WS_SLICE: Duration = Duration::from_millis(2);
const SNAPSHOT_PERSIST_INTERVAL: Duration = Duration::from_millis(500);
const ACTOR_TASK_YIELD: Duration = Duration::from_millis(10);

// Keep optional fan telemetry tied to the catalogue returned by this endpoint.
// A model name or a cached value from another host is not evidence that an
// object exists on the current printer.
struct FanTelemetryCatalogue {
    host: String,
    default_port: u16,
    names: Vec<String>,
}

fn fan_telemetry_objects<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut found = names
        .into_iter()
        .filter(|name| {
            name.len() <= 256
                && !name.chars().any(char::is_control)
                && (*name == "fan"
                    || *name == "output_pin fan0"
                    || name
                        .strip_prefix("fan_generic ")
                        .is_some_and(|suffix| !suffix.trim().is_empty()))
        })
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    let mut result = Vec::new();
    if found.remove("fan") {
        result.push("fan".to_string());
    }
    if found.remove("output_pin fan0") {
        result.push("output_pin fan0".to_string());
    }
    result.extend(found.into_iter().take(64 - result.len()));
    result
}

fn fan_telemetry_field(name: &str) -> &'static str {
    // Creality's live configuration maps the part-cooling macro to this
    // catalogue object. Klipper reports normalized PWM as value, not speed.
    // This is telemetry only; native code never writes an output pin here.
    if name == "output_pin fan0" { "value" } else { "speed" }
}

fn telemetry_reconcile_params(fan_names: &[String]) -> Value {
    let mut objects = serde_json::json!({
        "print_stats":null,
        "virtual_sdcard":["progress"],
        "extruder":["temperature","target"],
        "heater_bed":["temperature","target"],
        "webhooks":["state","state_message"]
    });
    for name in fan_names {
        objects[name] = serde_json::json!([fan_telemetry_field(name)]);
    }
    serde_json::json!({"objects":objects})
}

#[derive(Clone, Default)]
pub(super) struct ActorEventSink {
    app: Option<AppHandle>,
}

impl ActorEventSink {
    pub fn desktop(app: AppHandle) -> Self {
        Self { app: Some(app) }
    }

    pub fn headless() -> Self {
        Self { app: None }
    }

    fn emit(&self, event: ActorEvent) {
        if let Some(app) = self.app.as_ref() {
            let _ = app.emit(ACTOR_EVENT, event);
        }
    }
}

type ActorReply = mpsc::Sender<Result<OperationResult, String>>;
pub(crate) type BackgroundTask = Box<
    dyn FnOnce(
            ActorConfig,
            Journal,
            Arc<FarmScheduler>,
            Arc<dyn MoonrakerTransport>,
            Arc<AtomicBool>,
        ) -> Result<Value, String>
        + Send,
>;

enum ActorMessage {
    Operation {
        request: OperationRequest,
        cancelled: Arc<AtomicBool>,
        reply: ActorReply,
    },
    Reconfigure {
        config: Box<ActorConfig>,
        reply: mpsc::Sender<Result<ActorSnapshot, String>>,
    },
    Reattest {
        reply: mpsc::Sender<Result<ActorSnapshot, String>>,
    },
    Background {
        operation_id: String,
        cancelled: Arc<AtomicBool>,
        task: BackgroundTask,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    BackgroundFinished {
        operation_id: String,
        result: Result<Value, String>,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    Shutdown,
}

fn admit_actor_message(
    sender: &mpsc::SyncSender<ActorMessage>,
    message: ActorMessage,
) -> Result<(), String> {
    sender.try_send(message).map_err(|error| match error {
        mpsc::TrySendError::Full(_) => {
            "ACTOR_BUSY: ограниченная очередь PrinterActor заполнена".to_string()
        }
        mpsc::TrySendError::Disconnected(_) => "PrinterActor остановлен".to_string(),
    })
}

struct QueuedOperation {
    sequence: u64,
    request: OperationRequest,
    cancelled: Arc<AtomicBool>,
    reply: ActorReply,
}

impl PartialEq for QueuedOperation {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
    }
}

impl Eq for QueuedOperation {}

impl PartialOrd for QueuedOperation {
    fn partial_cmp(&self, other: &Self) -> Option<CompareOrdering> {
        Some(self.cmp(other))
    }
}

impl Ord for QueuedOperation {
    fn cmp(&self, other: &Self) -> CompareOrdering {
        self.request
            .priority
            .rank()
            .cmp(&other.request.priority.rank())
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

#[derive(Clone)]
pub struct ActorHandle {
    sender: mpsc::SyncSender<ActorMessage>,
    snapshot: Arc<Mutex<ActorSnapshot>>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    emergency: EmergencyTransport,
    alive: Arc<AtomicBool>,
}

#[derive(Clone)]
struct EmergencyTransport {
    event_sink: ActorEventSink,
    config: Arc<Mutex<ActorConfig>>,
    snapshot: Arc<Mutex<ActorSnapshot>>,
    journal: Journal,
    scheduler: Arc<FarmScheduler>,
    transport: Arc<dyn MoonrakerTransport>,
}

struct ActorExitGuard {
    alive: Arc<AtomicBool>,
    snapshot: Arc<Mutex<ActorSnapshot>>,
}

impl Drop for ActorExitGuard {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        let mut stable_id = None;
        if let Ok(mut snapshot) = self.snapshot.lock() {
            stable_id = Some(snapshot.stable_id.clone());
            snapshot.connected = false;
            snapshot.active_protocol = "disconnected".into();
            snapshot.active_operation_id = None;
            snapshot.active_upload_id = None;
            snapshot.queued_operations = 0;
            snapshot.update_blocking_operations = Some(0);
            if snapshot.phase != PrinterPhase::Quarantined {
                snapshot.phase = PrinterPhase::Degraded;
                snapshot.last_error = Some(
                    "ACTOR_STOPPED: worker завершился; постоянный supervisor выполнит безопасный перезапуск"
                        .into(),
                );
            }
        }
        crate::observability::record(
            "warn",
            "printer_actor",
            "ACTOR_STOPPED",
            None,
            "PrinterActor task завершилась",
            serde_json::json!({"stableId":stable_id}),
        );
    }
}

impl ActorHandle {
    pub fn spawn(
        event_sink: ActorEventSink,
        config: ActorConfig,
        journal: Journal,
        scheduler: Arc<FarmScheduler>,
        runtime: EngineRuntime,
        transport: Arc<dyn MoonrakerTransport>,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let actor_sender = sender.clone();
        let mut initial_snapshot = ActorSnapshot::new(&config);
        initial_snapshot.session_epoch = journal.reserve_actor_session_epoch(&config, 0)?;
        let snapshot = Arc::new(Mutex::new(initial_snapshot));
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let actor_snapshot = Arc::clone(&snapshot);
        let actor_cancellations = Arc::clone(&cancellations);
        let alive = Arc::new(AtomicBool::new(true));
        let actor_alive = Arc::clone(&alive);
        let exit_snapshot = Arc::clone(&snapshot);
        let runtime_error_snapshot = Arc::clone(&snapshot);
        let emergency = EmergencyTransport {
            event_sink: event_sink.clone(),
            config: Arc::new(Mutex::new(config.clone())),
            snapshot: Arc::clone(&snapshot),
            journal: journal.clone(),
            scheduler: Arc::clone(&scheduler),
            transport: Arc::clone(&transport),
        };
        let actor_runtime = runtime.clone();
        runtime.spawn(async move {
            let _exit_guard = ActorExitGuard {
                alive: actor_alive,
                snapshot: exit_snapshot,
            };
            let mut actor = PrinterActor::new(
                event_sink,
                config,
                actor_sender,
                receiver,
                actor_snapshot,
                actor_cancellations,
                journal,
                scheduler,
                actor_runtime.clone(),
                transport,
            );
            actor.start();
            loop {
                let step_runtime = actor_runtime.clone();
                let result = step_runtime
                    .run_blocking_in(ExecutionClass::ActorIo, move || {
                        let mut actor = actor;
                        let running = actor.run_step();
                        Ok((actor, running))
                    })
                    .await;
                match result {
                    Ok((next_actor, true)) => actor = next_actor,
                    Ok((mut next_actor, false)) => {
                        next_actor.finish();
                        break;
                    }
                    Err(error) => {
                        if let Ok(mut snapshot) = runtime_error_snapshot.lock() {
                            snapshot.last_error = Some(format!("ACTOR_RUNTIME_FAILED: {error}"));
                        }
                        break;
                    }
                }
                tokio::time::sleep(ACTOR_TASK_YIELD).await;
            }
        });
        Ok(Self {
            sender,
            snapshot,
            cancellations,
            emergency,
            alive,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn mark_restart_pending(&self, delay_ms: i64) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            snapshot.connected = false;
            snapshot.active_protocol = "disconnected".into();
            if snapshot.phase != PrinterPhase::Quarantined {
                snapshot.phase = PrinterPhase::Recovering;
                snapshot.last_error = Some(format!(
                    "ACTOR_RESTART_BACKOFF: повторный запуск через {} мс",
                    delay_ms.max(0)
                ));
            }
        }
    }

    pub fn mark_crash_loop(&self) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            snapshot.connected = false;
            snapshot.active_protocol = "disconnected".into();
            snapshot.phase = PrinterPhase::Quarantined;
            snapshot.last_error = Some(
                "ACTOR_CRASH_LOOP: автоматические перезапуски приостановлены; требуется reattest"
                    .into(),
            );
        }
    }

    pub fn config(&self) -> Result<ActorConfig, String> {
        self.emergency
            .config
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "Конфигурация PrinterActor недоступна".to_string())
    }

    pub fn printer_id(&self) -> String {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.printer_id.clone())
            .unwrap_or_default()
    }

    pub fn snapshot(&self) -> ActorSnapshot {
        // Every actor state transition publishes into this shared snapshot.
        // Reading it directly keeps ActorList, RuntimeSnapshot, Health and the
        // ActorUpsert acknowledgement independent from the actor I/O mailbox.
        // The old mailbox round-trip waited up to two seconds -- exactly the
        // timeout used by the native IPC regression -- and raced on Windows
        // while a freshly spawned actor was entering its I/O worker.
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    pub fn reconfigure(&self, config: ActorConfig) -> Result<ActorSnapshot, String> {
        *self
            .emergency
            .config
            .lock()
            .map_err(|_| "Emergency transport configuration недоступна")? = config.clone();
        // ActorUpsert is a registration/control-plane acknowledgement, not a
        // printer I/O barrier. Enqueue the update and return the lock-free
        // shared snapshot immediately. Waiting here used to hold the global
        // actor registry for ten seconds per printer during daemon restore.
        let (reply, _response) = mpsc::channel();
        admit_actor_message(
            &self.sender,
            ActorMessage::Reconfigure {
                config: Box::new(config),
                reply,
            },
        )?;
        Ok(self.snapshot())
    }

    pub fn reattest(&self) -> Result<ActorSnapshot, String> {
        let (reply, response) = mpsc::channel();
        admit_actor_message(&self.sender, ActorMessage::Reattest { reply })?;
        response
            .recv_timeout(Duration::from_secs(45))
            .map_err(|_| "PrinterActor не завершил повторную аттестацию")?
    }

    pub fn execute(&self, request: OperationRequest) -> Result<OperationResult, String> {
        if request.priority == OperationPriority::Emergency {
            return self.emergency.execute(request);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.cancellations
            .lock()
            .map_err(|_| "Состояние отмены PrinterActor недоступно")?
            .insert(request.operation_id.clone(), Arc::clone(&cancelled));
        let wait = Duration::from_millis(
            request
                .remaining_ms(now_ms())
                .saturating_add(2_000)
                .clamp(2_000, 180_000),
        );
        let operation_id = request.operation_id.clone();
        let (reply, response) = mpsc::channel();
        if let Err(error) = admit_actor_message(
            &self.sender,
            ActorMessage::Operation {
                request,
                cancelled,
                reply,
            },
        ) {
            if let Ok(mut items) = self.cancellations.lock() {
                items.remove(&operation_id);
            }
            return Err(error);
        }
        let result = response.recv_timeout(wait).map_err(|_| {
            format!("OPERATION_PENDING: PrinterActor продолжает операцию {operation_id} в фоне")
        })?;
        if let Ok(mut items) = self.cancellations.lock() {
            items.remove(&operation_id);
        }
        result
    }

    pub fn cancel(&self, operation_id: &str) -> Result<bool, String> {
        let items = self
            .cancellations
            .lock()
            .map_err(|_| "Состояние отмены PrinterActor недоступно")?;
        let Some(flag) = items.get(operation_id) else {
            return Ok(false);
        };
        flag.store(true, Ordering::Release);
        Ok(true)
    }

    pub fn run_background(
        &self,
        operation_id: String,
        cancelled: Arc<AtomicBool>,
        task: BackgroundTask,
    ) -> Result<Value, String> {
        self.cancellations
            .lock()
            .map_err(|_| "Состояние отмены PrinterActor недоступно")?
            .insert(operation_id.clone(), Arc::clone(&cancelled));
        let (reply, response) = mpsc::channel();
        if let Err(error) = admit_actor_message(
            &self.sender,
            ActorMessage::Background {
                operation_id: operation_id.clone(),
                cancelled,
                task,
                reply,
            },
        ) {
            if let Ok(mut items) = self.cancellations.lock() {
                items.remove(&operation_id);
            }
            return Err(error);
        }
        let result = response
            .recv_timeout(super::BACKGROUND_RESPONSE_TIMEOUT)
            .map_err(|_| format!("UPLOAD_PENDING: PrinterActor продолжает {operation_id}"))?;
        if let Ok(mut items) = self.cancellations.lock() {
            items.remove(&operation_id);
        }
        result
    }

    pub fn shutdown(&self) {
        if let Ok(items) = self.cancellations.lock() {
            for flag in items.values() {
                flag.store(true, Ordering::Release);
            }
        }
        let _ = self.sender.try_send(ActorMessage::Shutdown);
    }
}

impl EmergencyTransport {
    fn execute(&self, request: OperationRequest) -> Result<OperationResult, String> {
        if request.method != "printer.emergency_stop" {
            return Err("Emergency transport принимает только аварийную остановку".into());
        }
        let snapshot = self
            .snapshot
            .lock()
            .map_err(|_| "Снимок PrinterActor недоступен")?
            .clone();
        if request
            .expected_session_epoch
            .is_some_and(|epoch| epoch != snapshot.session_epoch)
        {
            return Err("STALE_SESSION: аварийная команда относится к старому соединению".into());
        }
        self.journal.create(
            &snapshot.stable_id,
            snapshot.session_epoch,
            &request,
            now_ms(),
        )?;
        self.journal.transition(
            &request.operation_id,
            OperationState::Sent,
            now_ms(),
            None,
            None,
            true,
        )?;
        let config = self
            .config
            .lock()
            .map_err(|_| "Emergency transport configuration недоступна")?
            .clone();
        let active_host =
            target_for_port(&config.host, config.default_port, snapshot.active_port)?.authority;
        let mut permit = self.scheduler.acquire_for_printer(
            &snapshot.stable_id,
            OperationPriority::Emergency,
            Duration::from_secs(1),
        )?;
        let result = self
            .transport
            .rpc(MoonrakerRpcRequest {
                stable_id: snapshot.stable_id.clone(),
                host: active_host,
                api_key: config.api_key,
                method: request.method.clone(),
                params: request.params.clone(),
                prefer_rest: true,
                timeout_ms: request.timeout_ms.clamp(750, 2_500),
                default_port: config.default_port,
                priority: OperationPriority::Emergency,
                cancellation: kf_moonraker::CancellationToken::default(),
            })
            .map_err(String::from);
        match result {
            Ok(value) => {
                permit.success();
                self.journal.transition(
                    &request.operation_id,
                    OperationState::Confirmed,
                    now_ms(),
                    Some(&value),
                    None,
                    false,
                )?;
                self.publish_result(&snapshot, &request.operation_id, OperationState::Confirmed);
                Ok(OperationResult {
                    operation_id: request.operation_id,
                    session_epoch: snapshot.session_epoch,
                    state: OperationState::Confirmed,
                    recovered: false,
                    result: value,
                })
            }
            Err(error) => {
                self.journal.transition(
                    &request.operation_id,
                    OperationState::Unknown,
                    now_ms(),
                    None,
                    Some(&error),
                    false,
                )?;
                self.publish_result(&snapshot, &request.operation_id, OperationState::Unknown);
                Err(format!(
                    "RESULT_UNKNOWN [{}]: аварийная команда отправлялась отдельным transport; {error}",
                    request.operation_id
                ))
            }
        }
    }

    fn publish_result(&self, snapshot: &ActorSnapshot, operation_id: &str, state: OperationState) {
        let mut event = ActorEvent {
            event_id: 0,
            stable_id: snapshot.stable_id.clone(),
            printer_id: snapshot.printer_id.clone(),
            session_epoch: snapshot.session_epoch,
            kind: "emergency_result".into(),
            phase: snapshot.phase,
            eventtime: snapshot.last_eventtime,
            telemetry_updated_at: snapshot.telemetry_updated_at,
            nozzle_updated_at: snapshot.nozzle_updated_at,
            bed_updated_at: snapshot.bed_updated_at,
            job_updated_at: snapshot.job_updated_at,
            status: None,
            operation_id: Some(operation_id.to_string()),
            payload: Some(serde_json::json!({"state":state})),
        };
        if let Ok(event_id) = self.journal.append_event(&event, now_ms()) {
            event.event_id = event_id;
            self.event_sink.emit(event);
        }
    }
}

struct PrinterActor {
    event_sink: ActorEventSink,
    config: ActorConfig,
    sender: mpsc::SyncSender<ActorMessage>,
    receiver: mpsc::Receiver<ActorMessage>,
    shared_snapshot: Arc<Mutex<ActorSnapshot>>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    journal: Journal,
    scheduler: Arc<FarmScheduler>,
    runtime: EngineRuntime,
    transport: Arc<dyn MoonrakerTransport>,
    machine: PrinterStateMachine,
    snapshot: ActorSnapshot,
    queue: BinaryHeap<QueuedOperation>,
    next_sequence: u64,
    websocket: Option<PersistentWebSocket>,
    reconnect_at: Instant,
    last_reconcile: Instant,
    // Сколько REST-опросов подряд завершились ошибкой. Управляет отступом.
    reconcile_failures: u32,
    force_reconcile: bool,
    subscription_pending: bool,
    fan_catalogue: Option<FanTelemetryCatalogue>,
    recovered_epoch: Option<u64>,
    active_background_id: Option<String>,
    active_update_operation: bool,
    trace_sequence: u64,
    trace_observed: u64,
    snapshot_dirty: bool,
    last_snapshot_persist: Instant,
}

impl PrinterActor {
    #[allow(clippy::too_many_arguments)]
    fn new(
        event_sink: ActorEventSink,
        config: ActorConfig,
        sender: mpsc::SyncSender<ActorMessage>,
        receiver: mpsc::Receiver<ActorMessage>,
        shared_snapshot: Arc<Mutex<ActorSnapshot>>,
        cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
        journal: Journal,
        scheduler: Arc<FarmScheduler>,
        runtime: EngineRuntime,
        transport: Arc<dyn MoonrakerTransport>,
    ) -> Self {
        let snapshot = shared_snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
        Self {
            event_sink,
            config,
            sender,
            receiver,
            shared_snapshot,
            cancellations,
            journal,
            scheduler,
            runtime,
            transport,
            machine: PrinterStateMachine::new(PrinterPhase::Discovered),
            snapshot,
            queue: BinaryHeap::new(),
            next_sequence: 0,
            websocket: None,
            reconnect_at: Instant::now(),
            last_reconcile: Instant::now() - REST_RECONCILE_INTERVAL,
            reconcile_failures: 0,
            force_reconcile: false,
            subscription_pending: false,
            fan_catalogue: None,
            recovered_epoch: None,
            active_background_id: None,
            active_update_operation: false,
            trace_sequence: 0,
            trace_observed: 0,
            snapshot_dirty: false,
            last_snapshot_persist: Instant::now() - SNAPSHOT_PERSIST_INTERVAL,
        }
    }

    fn start(&mut self) {
        self.publish_snapshot("created", None, None);
    }

    fn run_step(&mut self) -> bool {
        self.flush_snapshot_if_due(false);
        if !self.drain_messages(MAX_INBOX_BURST) {
            return false;
        }
        if let Some(operation) = self.queue.pop() {
            self.execute_queued(operation);
            self.service_websocket_after_command();
            self.reconcile_if_due();
            return true;
        }

        if self.websocket.is_none() && Instant::now() >= self.reconnect_at {
            self.try_connect();
            return true;
        }

        if self.websocket.is_some() {
            match self.poll_websocket() {
                Ok(()) => {}
                Err(error) => self.connection_failed(error),
            }
            self.reconcile_if_due();
        }
        true
    }

    fn finish(&mut self) {
        self.flush_snapshot_if_due(true);
        if let Some(websocket) = self.websocket.take() {
            websocket.close();
        }
        while let Some(operation) = self.queue.pop() {
            let _ = self.journal.transition(
                &operation.request.operation_id,
                OperationState::Cancelled,
                now_ms(),
                None,
                Some("PrinterActor остановлен"),
                false,
            );
            let _ = operation.reply.send(Err("PrinterActor остановлен".into()));
        }
    }

    fn drain_messages(&mut self, maximum: usize) -> bool {
        for _ in 0..maximum {
            match self.receiver.try_recv() {
                Ok(message) => {
                    if !self.handle_message(message) {
                        return false;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => return true,
                Err(mpsc::TryRecvError::Disconnected) => return false,
            }
        }
        true
    }

    fn handle_message(&mut self, message: ActorMessage) -> bool {
        match message {
            ActorMessage::Operation {
                request,
                cancelled,
                reply,
            } => {
                if request.expired(now_ms()) {
                    if let Ok(mut items) = self.cancellations.lock() {
                        items.remove(&request.operation_id);
                    }
                    let _ = reply.send(Err(
                        "OPERATION_DEADLINE_EXCEEDED: команда истекла до постановки в очередь"
                            .into(),
                    ));
                    return true;
                }
                if request
                    .expected_session_epoch
                    .is_some_and(|epoch| epoch != self.snapshot.session_epoch)
                {
                    let _ = reply.send(Err(format!(
                        "STALE_SESSION: ожидаемая сессия {:?}, активная {}",
                        request.expected_session_epoch, self.snapshot.session_epoch
                    )));
                    return true;
                }
                if self.queue.len() >= MAX_OPERATION_QUEUE {
                    if let Ok(mut items) = self.cancellations.lock() {
                        items.remove(&request.operation_id);
                    }
                    let _ = reply.send(Err(format!(
                        "ACTOR_BUSY: очередь операций достигла безопасного лимита {MAX_OPERATION_QUEUE}"
                    )));
                    return true;
                }
                if let Err(error) = self.journal.create(
                    &self.config.stable_id,
                    self.snapshot.session_epoch,
                    &request,
                    now_ms(),
                ) {
                    let _ = reply.send(Err(error));
                    return true;
                }
                if let Err(error) = self.journal.transition(
                    &request.operation_id,
                    OperationState::Queued,
                    now_ms(),
                    None,
                    None,
                    false,
                ) {
                    if let Ok(mut items) = self.cancellations.lock() {
                        items.remove(&request.operation_id);
                    }
                    let _ = reply.send(Err(error));
                    return true;
                }
                self.next_sequence = self.next_sequence.wrapping_add(1);
                self.queue.push(QueuedOperation {
                    sequence: self.next_sequence,
                    request,
                    cancelled,
                    reply,
                });
                self.update_queue_size();
            }
            ActorMessage::Reconfigure { config, reply } => {
                let result = self.reconfigure(*config);
                let _ = reply.send(result);
            }
            ActorMessage::Reattest { reply } => {
                let result = self.reattest();
                let _ = reply.send(result);
            }
            ActorMessage::Background {
                operation_id,
                cancelled,
                task,
                reply,
            } => {
                if self.snapshot.phase == PrinterPhase::Quarantined {
                    let _ = reply.send(Err(
                        "PRINTER_QUARANTINED: upload разрешён только после reattest".into(),
                    ));
                    return true;
                }
                if self.active_background_id.is_some() {
                    let _ = reply.send(Err("Для этого принтера уже выполняется upload".into()));
                    return true;
                }
                if cancelled.load(Ordering::Acquire) {
                    let _ = reply.send(Err("Upload отменён до запуска".into()));
                    return true;
                }
                let config = match active_actor_config(&self.config, self.snapshot.active_port) {
                    Ok(config) => config,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return true;
                    }
                };
                self.active_background_id = Some(operation_id.clone());
                self.snapshot.active_upload_id = Some(operation_id.clone());
                self.publish_snapshot("upload_active", None, None);
                let sender = self.sender.clone();
                let journal = self.journal.clone();
                let scheduler = Arc::clone(&self.scheduler);
                let transport = Arc::clone(&self.transport);
                let worker_operation_id = operation_id.clone();
                let worker_runtime = self.runtime.clone();
                self.runtime.spawn(async move {
                    let result = worker_runtime
                        .run_blocking_in(ExecutionClass::FileIo, move || {
                            task(config, journal, scheduler, transport, cancelled)
                        })
                        .await;
                    let send_runtime = worker_runtime.clone();
                    let _ = send_runtime
                        .run_blocking(move || {
                            sender
                                .send(ActorMessage::BackgroundFinished {
                                    operation_id: worker_operation_id,
                                    result,
                                    reply,
                                })
                                .map_err(|_| "PrinterActor остановлен до завершения upload".into())
                        })
                        .await;
                });
            }
            ActorMessage::BackgroundFinished {
                operation_id,
                result,
                reply,
            } => {
                if self.active_background_id.as_deref() == Some(operation_id.as_str()) {
                    self.active_background_id = None;
                    self.snapshot.active_upload_id = None;
                    if let Ok(mut cancellations) = self.cancellations.lock() {
                        cancellations.remove(&operation_id);
                    }
                    self.publish_snapshot(
                        if result.is_ok() {
                            "upload_complete"
                        } else {
                            "upload_failed"
                        },
                        None,
                        None,
                    );
                }
                let _ = reply.send(result);
            }
            ActorMessage::Shutdown => return false,
        }
        true
    }

    fn reconfigure(&mut self, config: ActorConfig) -> Result<ActorSnapshot, String> {
        let mut previous_target = parse_target(&self.config.host, self.config.default_port)?.socket;
        let mut next_target = parse_target(&config.host, config.default_port)?.socket;
        previous_target.set_port(0);
        next_target.set_port(0);
        let physical_address_changed = previous_target != next_target;
        let endpoint_changed = self.config.host != config.host
            || self.config.default_port != config.default_port
            || self.config.api_key != config.api_key;
        let next_epoch = if endpoint_changed {
            Some(self.journal.reserve_actor_session_epoch(&config, self.snapshot.session_epoch)?)
        } else {
            None
        };
        let firmware_hint_changed = self.config.firmware_signature != config.firmware_signature;
        self.config = config;
        self.snapshot.printer_id = self.config.printer_id.clone();
        self.snapshot.stable_id = self.config.stable_id.clone();
        self.snapshot.model_id = self.config.model_id.clone();
        self.snapshot.host = self.config.host.clone();
        if endpoint_changed {
            self.snapshot.active_port = self.config.default_port;
            if let Some(operation_id) = self.active_background_id.as_deref() {
                if let Ok(cancellations) = self.cancellations.lock() {
                    if let Some(flag) = cancellations.get(operation_id) {
                        flag.store(true, Ordering::Release);
                    }
                }
            }
            if let Some(websocket) = self.websocket.take() {
                websocket.close();
            }
            self.snapshot.session_epoch = next_epoch.expect("endpoint change reserved an epoch");
            self.snapshot.last_eventtime = None;
            self.snapshot.connected = false;
            self.snapshot.active_protocol = "disconnected".into();
            if physical_address_changed {
                // A new physical target must prove its own live state. Values
                // from the previous IP cannot become telemetry for this one.
                self.snapshot.cached_status = Value::Object(Default::default());
                self.snapshot.last_seen_at = None;
                self.snapshot.telemetry_updated_at = None;
                self.snapshot.nozzle_updated_at = None;
                self.snapshot.bed_updated_at = None;
                self.snapshot.job_updated_at = None;
                self.snapshot.identity_attestation = None;
                self.snapshot.last_error = None;
                self.snapshot.reconnect_attempt = 0;
                self.snapshot.capabilities = Default::default();
            }
            self.recovered_epoch = None;
            self.subscription_pending = false;
            self.machine = PrinterStateMachine::new(PrinterPhase::Recovering);
            self.snapshot.phase = PrinterPhase::Recovering;
            self.reconnect_at = Instant::now();
            self.force_reconcile = true;
        } else if firmware_hint_changed {
            // Reconfigure is an IPC control path and must stay bounded. The
            // previous implementation ran a long sequence of printer probes
            // here, serialising desktop startup behind firmware attestation.
            self.force_reconcile = true;
            self.publish_snapshot("firmware_hint_changed", None, None);
        }
        self.persist_snapshot();
        self.publish_snapshot("reconfigured", None, None);
        Ok(self.snapshot.clone())
    }

    fn force_quarantine_with_kind(&mut self, reason: String, event_kind: &str) {
        if let Some(operation_id) = self.active_background_id.as_deref() {
            if let Ok(cancellations) = self.cancellations.lock() {
                if let Some(flag) = cancellations.get(operation_id) {
                    flag.store(true, Ordering::Release);
                }
            }
        }
        self.machine.force_quarantine();
        self.snapshot.phase = PrinterPhase::Quarantined;
        self.snapshot.last_error = Some(reason);
        self.persist_snapshot();
        self.publish_snapshot(event_kind, None, None);
    }

    fn try_connect(&mut self) {
        if self.machine.phase() == PrinterPhase::Quarantined {
            if transient_attestation_quarantine(self.snapshot.last_error.as_deref()) {
                if self.machine.transition(PrinterPhase::Identifying).is_ok() {
                    self.snapshot.phase = PrinterPhase::Identifying;
                    self.snapshot.last_error = None;
                }
            } else {
                return;
            }
        }
        let epoch = match self.journal.reserve_actor_session_epoch(&self.config, self.snapshot.session_epoch) {
            Ok(epoch) => epoch,
            Err(error) => {
                self.force_quarantine_with_kind(error, "session_epoch_reservation_failed");
                return;
            }
        };
        self.set_phase(PrinterPhase::Identifying);
        self.snapshot.session_epoch = epoch;
        self.snapshot.last_eventtime = None;
        self.trace_sequence = 0;
        self.trace_observed = 0;
        // The desktop must see the new generation before slow socket attempts,
        // rather than waiting for their success or timeout to learn its epoch.
        self.publish_snapshot("connecting", None, None);
        let scheduler = Arc::clone(&self.scheduler);
        let mut permit = match scheduler.acquire_for_printer(
            &self.config.stable_id,
            OperationPriority::Background,
            Duration::from_secs(15),
        ) {
            Ok(permit) => permit,
            Err(error) => {
                self.connection_failed(error);
                return;
            }
        };
        let connection = self.connect_websocket();
        if connection.is_ok() {
            permit.success();
        }
        drop(permit);
        match connection {
            Ok((websocket, active_port)) => {
                self.websocket = Some(websocket);
                self.snapshot.connected = true;
                self.snapshot.active_protocol = "websocket".into();
                self.snapshot.active_port = active_port;
                self.subscription_pending = false;
                self.snapshot.reconnect_attempt = 0;
                self.snapshot.last_error = None;
                self.last_reconcile = Instant::now() - REST_RECONCILE_INTERVAL;
                let subscription_ready = match self.initialize_subscription() {
                    Ok(()) => true,
                    Err(error) => {
                        // Some vendor Moonraker builds expose a working RPC/REST
                        // endpoint but reject or omit the object catalogue used by
                        // subscription setup. Keep the transport alive and let the
                        // bounded REST reconciler obtain telemetry.
                        self.snapshot.last_error = Some(format!(
                            "SUBSCRIPTION_DEGRADED: {}",
                            error.chars().take(400).collect::<String>()
                        ));
                        self.set_phase(PrinterPhase::Degraded);
                        self.force_reconcile = true;
                        false
                    }
                };
                // Identity/capability discovery is diagnostic. It must not
                // delay initial farm telemetry or automatically quarantine a
                // configured printer.
                if subscription_ready {
                    self.phase_from_cached_status();
                }
                self.persist_snapshot();
                self.publish_snapshot("connected", None, None);
                self.recover_journal();
            }
            Err(error) => {
                self.connection_failed(error);
            }
        }
    }

    fn connect_websocket(&self) -> Result<(PersistentWebSocket, u16), String> {
        let configured = parse_target(&self.config.host, self.config.default_port)?
            .socket
            .port();
        let mut ports = vec![configured];
        if configured == 80 {
            ports.push(7125);
        } else if configured == 7125 {
            ports.push(80);
        }
        let mut errors = Vec::new();
        for port in ports {
            match PersistentWebSocket::connect(&self.config, port, self.runtime.clone()) {
                Ok(websocket) => return Ok((websocket, port)),
                Err(error) => errors.push(format!(":{port} {error}")),
            }
        }
        Err(format!(
            "Moonraker WebSocket недоступен: {}",
            errors.join("; ")
        ))
    }

    fn active_host(&self) -> Result<String, String> {
        Ok(target_for_port(
            &self.config.host,
            self.config.default_port,
            self.snapshot.active_port,
        )?
        .authority)
    }

    fn transport_rpc(
        &self,
        host: String,
        method: &str,
        params: Option<Value>,
        prefer_rest: bool,
        timeout_ms: u64,
        priority: OperationPriority,
        cancellation: kf_moonraker::CancellationToken,
    ) -> Result<Value, String> {
        self.transport
            .rpc(MoonrakerRpcRequest {
                stable_id: self.config.stable_id.clone(),
                host,
                api_key: self.config.api_key.clone(),
                method: method.to_string(),
                params,
                prefer_rest,
                timeout_ms,
                default_port: self.config.default_port,
                priority,
                cancellation,
            })
            .map_err(String::from)
    }

    fn initialize_subscription(&mut self) -> Result<(), String> {
        self.fan_catalogue = None;
        let listed = self.ws_request("printer.objects.list", None, WS_RPC_TIMEOUT)?;
        let names = listed
            .pointer("/objects")
            .or_else(|| listed.pointer("/result/objects"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<std::collections::HashSet<_>>();
        if names.is_empty() {
            return Err("Moonraker не вернул каталог printer objects".into());
        }
        let mut objects = serde_json::Map::new();
        for (name, fields) in [
            ("print_stats", Value::Null),
            ("virtual_sdcard", serde_json::json!(["progress"])),
            ("extruder", serde_json::json!(["temperature", "target"])),
            ("heater_bed", serde_json::json!(["temperature", "target"])),
            ("webhooks", serde_json::json!(["state", "state_message"])),
            ("display_status", Value::Null),
            ("toolhead", serde_json::json!(["position"])),
            ("gcode_move", serde_json::json!(["speed_factor"])),
        ] {
            if names.contains(name) {
                objects.insert(name.into(), fields);
            }
        }
        let fan_names = fan_telemetry_objects(names.iter().copied());
        for name in &fan_names {
            objects.insert(name.clone(), serde_json::json!([fan_telemetry_field(name)]));
        }
        self.fan_catalogue = Some(FanTelemetryCatalogue {
            host: self.config.host.clone(),
            default_port: self.config.default_port,
            names: fan_names,
        });
        for name in names
            .iter()
            .filter(|name| {
                name.starts_with("filament_switch_sensor ")
                    || name.starts_with("filament_motion_sensor ")
            })
            .take(64)
        {
            objects.insert(
                (*name).to_string(),
                serde_json::json!(["filament_detected", "enabled"]),
            );
        }
        let result = self.ws_request(
            "printer.objects.subscribe",
            Some(&serde_json::json!({"objects":Value::Object(objects)})),
            WS_RPC_TIMEOUT,
        )?;
        self.apply_query_status(&result, "subscription");
        Ok(())
    }

    fn attest_capabilities(&mut self) {
        let previous_signature = self
            .snapshot
            .capabilities
            .firmware_signature
            .clone()
            .or_else(|| self.config.firmware_signature.clone());
        let server = self.ws_request("server.info", None, WS_RPC_TIMEOUT).ok();
        let printer = self.ws_request("printer.info", None, WS_RPC_TIMEOUT).ok();
        let objects = self
            .ws_request("printer.objects.list", None, WS_RPC_TIMEOUT)
            .ok();
        let config = self
            .ws_request(
                "printer.objects.query",
                Some(&serde_json::json!({"objects":{"configfile":["settings","config"],"toolhead":["axis_minimum","axis_maximum"]}})),
                WS_RPC_TIMEOUT,
            )
            .ok();
        let webcams = self
            .ws_request("server.webcams.list", None, Duration::from_secs(4))
            .ok();
        let active_host = self
            .active_host()
            .unwrap_or_else(|_| self.config.host.clone());
        let rest_available = self
            .scheduler
            .acquire_for_printer(
                &self.config.stable_id,
                OperationPriority::Telemetry,
                Duration::from_secs(15),
            )
            .and_then(|mut permit| {
                let result = self.transport_rpc(
                    active_host,
                    "server.info",
                    None,
                    true,
                    3_000,
                    OperationPriority::Telemetry,
                    kf_moonraker::CancellationToken::default(),
                );
                if result.is_ok() {
                    permit.success();
                }
                result
            })
            .is_ok();
        let attested = capabilities::attest(
            server.as_ref(),
            printer.as_ref(),
            objects.as_ref(),
            config.as_ref(),
            webcams.as_ref(),
            true,
            rest_available,
            now_ms(),
        );
        let firmware_changed = previous_signature
            .as_deref()
            .zip(attested.firmware_signature.as_deref())
            .is_some_and(|(previous, current)| previous != current);
        self.snapshot.capabilities = attested;
        if !self.snapshot.capabilities.compatible {
            crate::observability::record(
                "warn",
                "printer_actor",
                "CAPABILITY_ATTESTATION_WARNING",
                Some(&self.config.printer_id),
                "Неполный каталог возможностей сохранён как предупреждение без автоматического quarantine",
                serde_json::json!({"reason": self.snapshot.capabilities.quarantine_reason.as_deref()}),
            );
            self.publish_snapshot(
                if firmware_changed {
                    "firmware_warning"
                } else {
                    "capability_warning"
                },
                None,
                Some(serde_json::to_value(&self.snapshot.capabilities).unwrap_or(Value::Null)),
            );
        } else {
            self.publish_snapshot(
                if firmware_changed {
                    "firmware_reattested"
                } else {
                    "capabilities"
                },
                None,
                Some(serde_json::to_value(&self.snapshot.capabilities).unwrap_or(Value::Null)),
            );
        }
    }

    fn attest_identity(&mut self, allow_fingerprint_refresh: bool) {
        let machine = self
            .ws_request("machine.system_info", None, WS_RPC_TIMEOUT)
            .ok();
        let printer = self.ws_request("printer.info", None, WS_RPC_TIMEOUT).ok();
        let config = self
            .ws_request(
                "printer.objects.query",
                Some(&serde_json::json!({"objects":{"configfile":["settings"]}})),
                WS_RPC_TIMEOUT,
            )
            .ok();
        let baseline = self
            .journal
            .identity_baseline(&self.config.stable_id)
            .ok()
            .flatten();
        let expected_stable_id = baseline
            .as_ref()
            .map(|(stable_id, _)| stable_id.as_str())
            .unwrap_or(&self.config.stable_id);
        let mut attestation = identity::attest(
            expected_stable_id,
            machine.as_ref(),
            printer.as_ref(),
            config.as_ref(),
            now_ms(),
        );
        if attestation.verified
            && expected_stable_id.starts_with("kf-device-")
            && !allow_fingerprint_refresh
        {
            if let Some((_, expected_fingerprint)) = baseline.as_ref() {
                if expected_fingerprint != &attestation.fingerprint {
                    attestation.verified = false;
                    attestation.reason = Some(format!(
                        "IDENTITY_FINGERPRINT_MISMATCH: ожидался {expected_fingerprint}, принтер подтвердил {}",
                        attestation.fingerprint
                    ));
                }
            }
        }
        let verified = attestation.verified;
        let reason = attestation.reason.clone();
        let _ = self
            .journal
            .save_identity_attestation(&self.config.stable_id, &attestation);
        self.snapshot.identity_attestation = Some(attestation.clone());
        if !verified {
            crate::observability::record(
                "warn",
                "printer_actor",
                "IDENTITY_ATTESTATION_WARNING",
                Some(&self.config.printer_id),
                "Изменение цифрового отпечатка сохранено как предупреждение без автоматического quarantine",
                serde_json::json!({"reason":reason}),
            );
            self.publish_snapshot(
                "identity_warning",
                None,
                Some(serde_json::to_value(attestation).unwrap_or(Value::Null)),
            );
        } else {
            self.publish_snapshot(
                "identity_attested",
                None,
                Some(serde_json::to_value(attestation).unwrap_or(Value::Null)),
            );
        }
    }

    fn reattest(&mut self) -> Result<ActorSnapshot, String> {
        if self.snapshot.phase != PrinterPhase::Quarantined {
            return Err("REAttest разрешён только для принтера в quarantine".into());
        }
        self.machine.transition(PrinterPhase::Identifying)?;
        self.snapshot.phase = PrinterPhase::Identifying;
        self.snapshot.last_error = None;
        self.snapshot.identity_attestation = None;
        self.publish_snapshot("reattest_started", None, None);
        if self.websocket.is_none() {
            self.reconnect_at = Instant::now();
            self.try_connect();
        }
        if self.websocket.is_some() {
            if self.snapshot.phase == PrinterPhase::Quarantined {
                self.machine.transition(PrinterPhase::Identifying)?;
                self.snapshot.phase = PrinterPhase::Identifying;
                self.snapshot.last_error = None;
            }
            self.attest_identity(true);
            if self.snapshot.phase != PrinterPhase::Quarantined {
                self.attest_capabilities();
            }
            if self.snapshot.phase != PrinterPhase::Quarantined {
                self.phase_from_cached_status();
                self.persist_snapshot();
                self.publish_snapshot("reattest_confirmed", None, None);
            }
        }
        let identity_ok = self
            .snapshot
            .identity_attestation
            .as_ref()
            .is_some_and(|attestation| attestation.verified);
        if !self.snapshot.connected || !identity_ok {
            self.machine.force_quarantine();
            self.snapshot.phase = PrinterPhase::Quarantined;
            self.snapshot.last_error.get_or_insert_with(|| {
                "Повторная аттестация не смогла подтвердить соединение и stable ID".into()
            });
            self.persist_snapshot();
        }
        if self.snapshot.phase == PrinterPhase::Quarantined {
            return Err(self
                .snapshot
                .last_error
                .clone()
                .unwrap_or_else(|| "Повторная аттестация не пройдена".into()));
        }
        Ok(self.snapshot.clone())
    }

    fn poll_websocket(&mut self) -> Result<(), String> {
        let notification = {
            let websocket = self.websocket.as_mut().ok_or("WebSocket отсутствует")?;
            websocket.poll(WS_IDLE_SLICE)?
        };
        if let Some(notification) = notification {
            self.handle_notification(notification);
        }
        Ok(())
    }

    fn service_websocket_after_command(&mut self) {
        let Some(websocket) = self.websocket.as_mut() else {
            return;
        };
        let result = websocket.poll(POST_COMMAND_WS_SLICE);
        match result {
            Ok(Some(notification)) => self.handle_notification(notification),
            Ok(None) => {}
            Err(error) => self.connection_failed(error),
        }
    }

    fn reconcile_if_due(&mut self) {
        // После серии неудач опрашиваем реже, чтобы не долбить спящий принтер и не
        // заваливать журнал. Успех возвращает обычный интервал.
        let interval = if self.reconcile_failures == 0 {
            REST_RECONCILE_INTERVAL
        } else {
            let shift = self.reconcile_failures.saturating_sub(1).min(3);
            (REST_RECONCILE_INTERVAL * (1_u32 << shift)).min(REST_RECONCILE_MAX_INTERVAL)
        };
        if self.force_reconcile || self.last_reconcile.elapsed() >= interval {
            let result = self.reconcile_status();
            match &result {
                Ok(_) => self.reconcile_failures = 0,
                Err(_) => {
                    self.reconcile_failures = self.reconcile_failures.saturating_add(1);
                }
            }
            if result.is_err() {
                // Object queries are unavailable during a Klipper shutdown.
                // printer.info remains readable and carries the actual heater
                // error; a live Moonraker must not become an endless connector.
                self.refresh_klippy_info();
            }
            if self.subscription_pending && self.websocket.is_some()
                && self.snapshot.cached_status.pointer("/webhooks/state").and_then(Value::as_str) == Some("ready")
                && self.initialize_subscription().is_ok()
            {
                self.subscription_pending = false;
            }
            if self.websocket.is_some()
                && self.snapshot.phase == PrinterPhase::Quarantined
                && transient_attestation_quarantine(self.snapshot.last_error.as_deref())
            {
                // Firmware identity/object probes can fail briefly while the
                // same websocket continues delivering temperatures and job
                // state. Retry the safety proof automatically instead of
                // leaving the whole farm in a sticky quarantine forever.
                if self.machine.transition(PrinterPhase::Identifying).is_ok() {
                    self.snapshot.phase = PrinterPhase::Identifying;
                    self.snapshot.last_error = None;
                    self.attest_identity(false);
                    if self.snapshot.phase != PrinterPhase::Quarantined {
                        self.attest_capabilities();
                    }
                    if self.snapshot.phase != PrinterPhase::Quarantined {
                        self.phase_from_cached_status();
                        self.persist_snapshot();
                        self.publish_snapshot("attestation_recovered", None, None);
                    }
                }
            }
            let observed_at = now_ms();
            if connection_observation_stale(self.snapshot.last_seen_at, observed_at) {
                let detail = result
                    .err()
                    .unwrap_or_else(|| "Moonraker ответил без пригодного status payload".into());
                crate::observability::record(
                    "warn",
                    "printer_actor",
                    "ACTOR_TELEMETRY_STALE_RECONNECT",
                    None,
                    "WebSocket и REST давно не подтверждали телеметрию; соединение пересоздаётся",
                    serde_json::json!({
                        "stableId":&self.config.stable_id,
                        "dataAgeMs":self.snapshot.last_seen_at.map(|seen| observed_at.saturating_sub(seen)),
                        "error":&detail,
                    }),
                );
                self.connection_failed(format!(
                    "Moonraker не подтверждает телеметрию более {} с: {detail}",
                    CONNECTION_STALE_RECONNECT_MS / 1_000
                ));
            }
        }
    }

    fn ws_request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.ws_request_cancellable(
            method,
            params,
            timeout,
            kf_moonraker::CancellationToken::default(),
        )
    }

    fn ws_request_cancellable(
        &mut self,
        method: &str,
        params: Option<&Value>,
        timeout: Duration,
        cancellation: kf_moonraker::CancellationToken,
    ) -> Result<Value, String> {
        self.record_trace(
            "client_to_printer",
            serde_json::json!({"jsonrpc":"2.0","method":method,"params":params}),
        );
        let response = {
            let websocket = self.websocket.as_mut().ok_or("WebSocket отсутствует")?;
            websocket.request_cancellable(method, params, timeout, cancellation)
        };
        let (result, notifications) = match response {
            Ok(response) => response,
            Err(error) => {
                self.record_trace(
                    "printer_to_client",
                    serde_json::json!({"method":method,"error":error.clone()}),
                );
                return Err(error);
            }
        };
        self.record_trace(
            "printer_to_client",
            serde_json::json!({"method":method,"result":result.clone()}),
        );
        for notification in notifications {
            self.handle_notification(notification);
        }
        Ok(result)
    }

    fn handle_notification(&mut self, notification: Value) {
        let method = notification
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.trace_observed = self.trace_observed.saturating_add(1);
        if self.snapshot.active_operation_id.is_some()
            || method != "notify_status_update"
            || self.trace_observed.is_multiple_of(10)
        {
            self.record_trace("printer_to_client", notification.clone());
        }
        match method {
            "notify_status_update" => {
                let status = notification
                    .pointer("/params/0")
                    .cloned()
                    .unwrap_or(Value::Null);
                let eventtime = notification.pointer("/params/1").and_then(Value::as_f64);
                self.apply_status(status, eventtime, "websocket");
            }
            "notify_klippy_ready" => {
                // Moonraker can keep the same socket while Klipper restarts.
                // Its object subscriptions and monotonic event clock restart.
                self.snapshot.last_eventtime = None;
                self.subscription_pending = true;
                self.apply_status(serde_json::json!({"webhooks":{"state":"ready","state_message":"Printer is ready"}}), None, "klippy_ready");
                self.force_reconcile = true;
            }
            "notify_klippy_shutdown" => {
                // Кэш на этот момент ещё держит прежнее state_message (обычно "Printer is ready"),
                // поэтому причина аварии здесь неизвестна. Забираем её у Klipper сразу, иначе
                // оператор видит «Klippy перешёл в shutdown» без причины — а причина (Timer too close,
                // Lost communication with MCU, ADC out of range) и есть то, что нужно для ремонта.
                let reported = self
                    .ws_request("printer.info", None, WS_RPC_TIMEOUT)
                    .ok()
                    .and_then(|info| info.get("state_message").and_then(Value::as_str).map(str::to_owned));
                let message = reported
                    .filter(|message| !message.trim().is_empty() && message != "Printer is ready")
                    .or_else(|| self.snapshot.cached_status.pointer("/webhooks/state_message")
                        .and_then(Value::as_str)
                        .filter(|message| !message.is_empty() && *message != "Printer is ready")
                        .map(str::to_owned))
                    .unwrap_or_else(|| "Klipper остановлен без сообщения. Проверьте экран принтера и журнал klippy.log.".to_string());
                self.subscription_pending = true;
                self.apply_status(serde_json::json!({"webhooks":{"state":"shutdown","state_message":message}}), None, "klippy_shutdown");
                self.force_reconcile = true;
            }
            "notify_klippy_disconnected" => {
                self.snapshot.last_eventtime = None;
                self.subscription_pending = true;
                self.apply_status(serde_json::json!({"webhooks":{"state":"disconnected","state_message":"Moonraker доступен, Klipper переподключается"}}), None, "klippy_disconnected");
                self.force_reconcile = true;
            }
            "notify_filelist_changed" | "notify_gcode_response" | "notify_job_queue_changed" => {
                self.publish_snapshot(
                    method.trim_start_matches("notify_"),
                    None,
                    notification.get("params").cloned(),
                );
            }
            _ => {}
        }
    }

    fn apply_query_status(&mut self, value: &Value, source: &str) {
        let status = value
            .get("status")
            .or_else(|| value.pointer("/result/status"))
            .cloned();
        let eventtime = value
            .get("eventtime")
            .or_else(|| value.pointer("/result/eventtime"))
            .and_then(Value::as_f64);
        if let Some(status) = status {
            self.apply_status(status, eventtime, source);
        }
    }

    fn apply_status(&mut self, status: Value, eventtime: Option<f64>, source: &str) {
        if source != "websocket"
            && status.pointer("/webhooks/state").and_then(Value::as_str) == Some("ready")
            && self.snapshot.cached_status.pointer("/webhooks/state").and_then(Value::as_str)
                .is_some_and(|state| state != "ready")
        {
            // The ready notification can be lost while the UI is minimized.
            // A complete, fresh query also proves a new controller generation.
            self.snapshot.last_eventtime = None;
            self.subscription_pending = true;
        }
        if let Some(eventtime) = eventtime {
            let previous = self.snapshot.last_eventtime;
            // WebSocket notifications are deltas and must stay monotonic.  A
            // subscription/REST reconciliation is a complete snapshot: some
            // Creality and FlashForge forks legally repeat (or reset) the
            // same eventtime, so rejecting it would leave live job and heater
            // data to expire even though Moonraker answered successfully.
            if source == "websocket"
                && previous.is_some_and(|value| eventtime <= value)
            {
                return;
            }
            if previous.is_some_and(|value| eventtime > value && eventtime - value > 20.0)
            {
                self.force_reconcile = true;
            }
            if source != "websocket" || previous.is_none_or(|value| eventtime > value) {
                self.snapshot.last_eventtime = Some(eventtime);
            }
        }
        let observed_at = now_ms();
        let has_nozzle_temperature = observed_temperature(&status, "extruder").is_some();
        let has_bed_temperature = observed_temperature(&status, "heater_bed").is_some();
        let has_job = [
            "/print_stats/state",
            "/print_stats/filename",
            "/print_stats/print_duration",
            "/print_stats/total_duration",
            "/virtual_sdcard/progress",
        ]
        .iter()
        .any(|path| status.pointer(path).is_some_and(|value| !value.is_null()));
        if has_nozzle_temperature {
            self.snapshot.nozzle_updated_at = Some(observed_at);
        }
        if has_bed_temperature {
            self.snapshot.bed_updated_at = Some(observed_at);
        }
        if has_nozzle_temperature || has_bed_temperature {
            self.snapshot.telemetry_updated_at = core_temperature_observed_at(
                self.snapshot.nozzle_updated_at,
                self.snapshot.bed_updated_at,
            );
        }
        if has_job {
            self.snapshot.job_updated_at = Some(observed_at);
        }
        let new_fault = status.pointer("/webhooks/state").and_then(Value::as_str)
            .is_some_and(|state| matches!(state, "shutdown" | "error")
                && self.snapshot.cached_status.pointer("/webhooks/state").and_then(Value::as_str) != Some(state));
        merge_json(&mut self.snapshot.cached_status, status.clone());
        self.snapshot.last_seen_at = Some(observed_at);
        self.snapshot.connected = true;
        if self.snapshot.phase != PrinterPhase::Quarantined {
            self.snapshot.last_error = None;
        }
        self.phase_from_cached_status();
        self.mark_snapshot_dirty();
        let event_kind = if new_fault && source != "klippy_shutdown" { "printer_fault" } else { source };
        self.publish_snapshot(event_kind, Some(status), None);
    }

    fn refresh_klippy_info(&mut self) {
        let host = self.active_host().unwrap_or_else(|_| self.config.host.clone());
        let scheduler = Arc::clone(&self.scheduler);
        let Ok(mut permit) = scheduler.acquire_for_printer(&self.config.stable_id,
            OperationPriority::Telemetry, Duration::from_secs(3)) else { return; };
        let Ok(info) = self.transport_rpc(host, "printer.info", None, true, 3_000,
            OperationPriority::Telemetry, kf_moonraker::CancellationToken::default()) else { return; };
        let info = info.get("result").unwrap_or(&info);
        let Some(state) = info.get("state").and_then(Value::as_str)
            .filter(|state| matches!(*state, "ready" | "startup" | "shutdown" | "error" | "disconnected")) else { return; };
        permit.success();
        let previous = self.snapshot.cached_status.pointer("/webhooks/state").and_then(Value::as_str);
        if state == "ready" && previous.is_some_and(|previous| previous != "ready") {
            self.snapshot.last_eventtime = None;
            self.subscription_pending = true;
        }
        let message = info.get("state_message").and_then(Value::as_str)
            .unwrap_or(match state {
                "ready" => "Printer is ready",
                "shutdown" => "Klipper остановлен",
                "error" => "Ошибка Klipper",
                _ => "Moonraker доступен, Klipper переподключается",
            }).chars().take(1500).collect::<String>();
        self.apply_status(serde_json::json!({"webhooks":{"state":state,"state_message":message}}), None, "klippy_info");
    }

    fn phase_from_cached_status(&mut self) {
        if self.snapshot.phase == PrinterPhase::Quarantined {
            return;
        }
        match self.snapshot.cached_status.pointer("/webhooks/state").and_then(Value::as_str) {
            Some("shutdown" | "error") => {
                self.snapshot.last_error = Some(self.snapshot.cached_status.pointer("/webhooks/state_message")
                    .and_then(Value::as_str).filter(|message| !message.trim().is_empty())
                    .unwrap_or("Klipper сообщил об ошибке").chars().take(1500).collect());
                self.set_phase(PrinterPhase::Degraded);
                return;
            }
            Some("startup" | "starting" | "disconnected") => {
                self.set_phase(PrinterPhase::Recovering);
                return;
            }
            _ => {}
        }
        let state = self
            .snapshot
            .cached_status
            .pointer("/print_stats/state")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(state.as_str(), "printing" | "paused") {
            self.set_phase(PrinterPhase::Printing);
        } else {
            self.set_phase(PrinterPhase::Ready);
        }
    }

    fn execute_queued(&mut self, operation: QueuedOperation) {
        let request = operation.request;
        self.snapshot.active_operation_id = Some(request.operation_id.clone());
        // Use the actual method, never a caller-supplied priority/retry hint.
        self.active_update_operation = classify_method(&request.method).1 != OperationPriority::Telemetry;
        self.update_queue_size();
        self.publish_snapshot("operation_active", None, None);
        let result = self.execute_operation(&request, &operation.cancelled);
        self.snapshot.active_operation_id = None;
        self.active_update_operation = false;
        self.update_queue_size();
        if let Ok(mut cancellations) = self.cancellations.lock() {
            cancellations.remove(&request.operation_id);
        }
        let _ = operation.reply.send(result);
    }

    fn execute_operation(
        &mut self,
        request: &OperationRequest,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<OperationResult, String> {
        if request.expired(now_ms()) {
            self.journal.transition(
                &request.operation_id,
                OperationState::Cancelled,
                now_ms(),
                None,
                Some("Сквозной срок операции истёк в очереди"),
                false,
            )?;
            return Err("OPERATION_DEADLINE_EXCEEDED: команда не была отправлена".into());
        }
        if cancelled.load(Ordering::Acquire) {
            self.journal.transition(
                &request.operation_id,
                OperationState::Cancelled,
                now_ms(),
                None,
                Some("Операция отменена до отправки"),
                false,
            )?;
            return Err("Операция отменена".into());
        }
        if self.snapshot.phase == PrinterPhase::Quarantined
            && request.priority != OperationPriority::Emergency
            && request.repeat_policy != RepeatPolicy::Safe
        {
            self.journal.transition(
                &request.operation_id,
                OperationState::Failed,
                now_ms(),
                None,
                Some("Принтер помещён в безопасный карантин"),
                false,
            )?;
            return Err("PRINTER_QUARANTINED: повторите аттестацию возможностей".into());
        }
        if request
            .expected_session_epoch
            .is_some_and(|epoch| epoch != self.snapshot.session_epoch)
        {
            self.journal.transition(
                &request.operation_id,
                OperationState::Cancelled,
                now_ms(),
                None,
                Some("Ответ относится к устаревшей сессии"),
                false,
            )?;
            return Err("STALE_SESSION: соединение принтера уже изменилось".into());
        }
        if matches!(
            request.priority,
            OperationPriority::Control | OperationPriority::Emergency
        ) && self.snapshot.phase != PrinterPhase::Quarantined
        {
            self.set_phase(PrinterPhase::Operating);
        }

        let first = self.send_once(request, cancelled);
        match first {
            Ok(result) if request.method == "printer.print.start" => {
                self.verify_print_start(request, result, cancelled)
            }
            Ok(result) => self.confirm_operation(request, result, false),
            Err(error) if !ambiguous_transport_error(&error) => {
                self.journal.transition(
                    &request.operation_id,
                    OperationState::Failed,
                    now_ms(),
                    None,
                    Some(&error),
                    false,
                )?;
                self.phase_from_cached_status();
                Err(error)
            }
            Err(error) => {
                self.journal.transition(
                    &request.operation_id,
                    OperationState::Unknown,
                    now_ms(),
                    None,
                    Some(&error),
                    false,
                )?;
                let actual = self.reconcile_status().ok();
                if actual
                    .as_ref()
                    .is_some_and(|status| operation_observed(request, status)
                        && (!camera_guarded_pause(request) || camera_pause_guard(request, now_ms())
                            .is_ok_and(|guard| guard.is_some_and(|guard| guard.matches(status, now_ms(), true)))))
                {
                    self.journal.transition(
                        &request.operation_id,
                        OperationState::Recovered,
                        now_ms(),
                        actual.as_ref(),
                        Some("Подтверждение восстановлено по фактическому состоянию"),
                        false,
                    )?;
                    self.phase_from_cached_status();
                    return Ok(OperationResult {
                        operation_id: request.operation_id.clone(),
                        session_epoch: self.snapshot.session_epoch,
                        state: OperationState::Recovered,
                        recovered: true,
                        result: actual.unwrap_or(Value::Null),
                    });
                }
                if cancelled.load(Ordering::Acquire) {
                    self.journal.transition(
                        &request.operation_id,
                        OperationState::Cancelled,
                        now_ms(),
                        actual.as_ref(),
                        Some("Операция отменена после сверки состояния"),
                        false,
                    )?;
                    return Err("Операция отменена".into());
                }
                let may_retry = !camera_guarded_pause(request) && match request.repeat_policy {
                    RepeatPolicy::Safe => true,
                    RepeatPolicy::VerifyState => actual
                        .as_ref()
                        .is_some_and(|status| retry_is_safe(request, status)),
                    RepeatPolicy::Never => false,
                };
                if may_retry {
                    match self.send_once(request, cancelled) {
                        Ok(result) => return self.confirm_operation(request, result, true),
                        Err(retry_error) => {
                            self.journal.transition(
                                &request.operation_id,
                                OperationState::Unknown,
                                now_ms(),
                                actual.as_ref(),
                                Some(&retry_error),
                                false,
                            )?;
                            return Err(format!(
                                "RESULT_UNKNOWN [{}]: {}",
                                request.operation_id, retry_error
                            ));
                        }
                    }
                }
                self.phase_from_cached_status();
                Err(format!(
                    "RESULT_UNKNOWN [{}]: команда не повторена автоматически; {}",
                    request.operation_id, error
                ))
            }
        }
    }

    fn verify_print_start(
        &mut self,
        request: &OperationRequest,
        acknowledgement: Value,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<OperationResult, String> {
        // An RPC acknowledgement only proves that the command was accepted.
        // Observe a fresh job status; never infer success from cached state or
        // resend a start whose outcome could already be in progress.
        let deadline = Instant::now()
            + Duration::from_millis(request.remaining_ms(now_ms()).min(6_000));
        let mut last_status = Value::Null;
        let mut detail = "принтер не подтвердил состояние задания".to_string();
        let mut observe_via_rest = self.websocket.is_none();
        while Instant::now() < deadline && !cancelled.load(Ordering::Acquire) {
            let budget = deadline.saturating_duration_since(Instant::now());
            if budget < Duration::from_millis(100) { break; }
            // Native REST RPC has a one-second minimum timeout. Do not start
            // that read when the original verification budget cannot cover it.
            if observe_via_rest && budget < Duration::from_secs(1) { break; }
            let timeout = budget.min(Duration::from_millis(1_200));
            let token = kf_moonraker::CancellationToken::linked(Arc::clone(cancelled));
            let params = serde_json::json!({"objects":{"print_stats":null}});
            let response = if !observe_via_rest {
                self.ws_request_cancellable("printer.objects.query", Some(&params), timeout, token)
            } else {
                self.transport_rpc(
                    self.active_host().unwrap_or_else(|_| self.config.host.clone()),
                    "printer.objects.query", Some(params), true,
                    timeout.as_millis() as u64, OperationPriority::Control, token,
                )
            };
            match response {
                Ok(value) => {
                    last_status = extract_status(&value).unwrap_or_else(|| value.clone());
                    self.apply_query_status(&value, "print_start_verification");
                    if operation_observed(request, &last_status) {
                        return self.confirm_operation(request,
                            serde_json::json!({"acknowledgement":acknowledgement,"status":last_status}), false);
                    }
                    let state = last_status.pointer("/print_stats/state").and_then(Value::as_str).unwrap_or("unknown");
                    let filename = last_status.pointer("/print_stats/filename").and_then(Value::as_str).unwrap_or("");
                    let message = last_status.pointer("/print_stats/message").and_then(Value::as_str).unwrap_or("");
                    detail = format!("state={state}, filename={filename}; {message}");
                }
                Err(error) => {
                    detail = error;
                    // A start acknowledgement can precede a vendor socket
                    // restart. Recover only the observation over HTTP; the
                    // previously accepted print.start must never be resent.
                    observe_via_rest = true;
                }
            }
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(200)));
        }
        let error = format!(
            "PRINT_START_UNCONFIRMED [{}]: команда принята, запуск печати не подтверждён; {detail}. Проверьте принтер перед повтором",
            request.operation_id
        );
        self.journal.transition(&request.operation_id, OperationState::Unknown, now_ms(),
            Some(&last_status), Some(&error), false)?;
        self.phase_from_cached_status();
        self.publish_snapshot("operation_result", None,
            Some(serde_json::json!({"operationId":request.operation_id,"state":"unknown"})));
        Err(error)
    }

    fn send_once(
        &mut self,
        request: &OperationRequest,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<Value, String> {
        if cancelled.load(Ordering::Acquire) {
            return Err("Операция отменена".into());
        }
        let scheduler_wait_ms = request.remaining_ms(now_ms()).min(15_000);
        if scheduler_wait_ms < 100 {
            return Err("OPERATION_DEADLINE_EXCEEDED: не осталось времени на отправку".into());
        }
        let scheduler = Arc::clone(&self.scheduler);
        let mut permit = scheduler.acquire_for_printer(
            &self.config.stable_id,
            request.priority,
            Duration::from_millis(scheduler_wait_ms),
        )?;
        let camera_guard = camera_pause_guard(request, now_ms())?;
        if let Some(guard) = camera_guard.as_ref() {
            let remaining = request.remaining_ms(now_ms());
            if remaining < 350 {
                return Err("CAMERA_GUARD_BLOCKED: недостаточно времени для проверки задания".into());
            }
            let query_timeout = Duration::from_millis(remaining.min(2_000));
            let params = serde_json::json!({"objects":{"print_stats":null}});
            let token = kf_moonraker::CancellationToken::linked(Arc::clone(cancelled));
            let result = if self.websocket.is_some() {
                self.ws_request_cancellable("printer.objects.query", Some(&params), query_timeout, token)
            } else {
                self.transport_rpc(
                    self.active_host().unwrap_or_else(|_| self.config.host.clone()),
                    "printer.objects.query", Some(params), request.prefer_rest,
                    query_timeout.as_millis() as u64, OperationPriority::Control, token,
                )
            };
            // A preflight failure has sent no pause. Do not include a network
            // error string that could route this into ambiguous-command recovery.
            let result = result.map_err(|_| "CAMERA_GUARD_BLOCKED: не удалось проверить текущее задание".to_string())?;
            let status = extract_status(&result).unwrap_or_else(|| result.clone());
            camera_pause_guard(request, now_ms())?;
            if cancelled.load(Ordering::Acquire) || !guard.matches(&status, now_ms(), false) {
                return Err("CAMERA_GUARD_BLOCKED: текущее задание не совпадает с кадром камеры".into());
            }
            self.apply_query_status(&result, "camera_pause_preflight");
        }
        // A single actor serializes its command connection. Bound ordinary
        // calls so a stalled endpoint cannot starve a queued emergency.
        let timeout_cap = match request.priority {
            OperationPriority::Emergency => 5_000,
            OperationPriority::Control => 15_000,
            OperationPriority::Telemetry | OperationPriority::Background => 8_000,
            OperationPriority::Upload => 15_000,
        };
        let remaining_ms = request.remaining_ms(now_ms());
        if remaining_ms < 250 {
            return Err("OPERATION_DEADLINE_EXCEEDED: сетевой бюджет исчерпан".into());
        }
        self.journal.transition(
            &request.operation_id,
            OperationState::Sent,
            now_ms(),
            None,
            None,
            true,
        )?;
        let wire_remaining_ms = if camera_guard.is_some() {
            camera_pause_guard(request, now_ms())?;
            let remaining = request.remaining_ms(now_ms());
            if cancelled.load(Ordering::Acquire) || remaining < 250 {
                return Err("CAMERA_GUARD_BLOCKED: проверка задания больше не действует".into());
            }
            remaining
        } else { remaining_ms };
        let effective_timeout_ms = request.timeout_ms.clamp(250, timeout_cap).min(wire_remaining_ms);
        let timeout = Duration::from_millis(effective_timeout_ms);
        let result = if self.websocket.is_some() && !request.prefer_rest {
            let response = self.ws_request_cancellable(
                &request.method,
                if camera_guard.is_some() { None } else { request.params.as_ref() },
                timeout,
                kf_moonraker::CancellationToken::linked(Arc::clone(cancelled)),
            );
            match response {
                Err(error) if request.method == "printer.print.start"
                    && error == "ASYNC_WEBSOCKET_DISCONNECTED" => {
                    // This exact error comes only from try_send rejecting the
                    // RPC before queue admission. No WS command was sent, so
                    // dispatch its first and only start through the REST API.
                    // Timeouts and connection loss after admission never enter
                    // this branch because their outcome is ambiguous.
                    self.connection_failed(error);
                    let remaining = request.remaining_ms(now_ms());
                    if cancelled.load(Ordering::Acquire) || remaining < 1_000 {
                        Err("OPERATION_DEADLINE_EXCEEDED: команда печати не была отправлена".into())
                    } else {
                        self.transport_rpc(
                            self.active_host().unwrap_or_else(|_| self.config.host.clone()),
                            &request.method, request.params.clone(), true,
                            request.timeout_ms.clamp(1_000, timeout_cap).min(remaining),
                            request.priority,
                            kf_moonraker::CancellationToken::linked(Arc::clone(cancelled)),
                        )
                    }
                }
                other => other,
            }
        } else {
            self.transport_rpc(
                self.active_host()
                    .unwrap_or_else(|_| self.config.host.clone()),
                &request.method,
                if camera_guard.is_some() { None } else { request.params.clone() },
                request.prefer_rest,
                effective_timeout_ms,
                request.priority,
                kf_moonraker::CancellationToken::linked(Arc::clone(cancelled)),
            )
        };
        if result.is_ok() {
            permit.success();
        }
        result
    }

    fn remember_fan_query_result(&mut self, request: &OperationRequest, result: &Value) {
        if request.method == "printer.objects.list" {
            if let Some(names) = result
                .get("objects")
                .or_else(|| result.pointer("/result/objects"))
                .and_then(Value::as_array)
            {
                self.fan_catalogue = Some(FanTelemetryCatalogue {
                    host: self.config.host.clone(),
                    default_port: self.config.default_port,
                    names: fan_telemetry_objects(names.iter().filter_map(Value::as_str)),
                });
            }
            return;
        }
        if request.method != "printer.objects.query" {
            return;
        }
        let Some(catalogue) = self.fan_catalogue.as_ref().filter(|catalogue| {
            catalogue.host == self.config.host
                && catalogue.default_port == self.config.default_port
        }) else { return; };
        let Some(requested) = request.params.as_ref()
            .and_then(|params| params.get("objects"))
            .and_then(Value::as_object) else { return; };
        let Some(status) = extract_status(result) else { return; };
        let mut fans = serde_json::Map::new();
        for name in &catalogue.names {
            let field = fan_telemetry_field(name);
            let level_requested = requested.get(name).is_some_and(|fields| {
                fields.is_null() || fields.as_array().is_some_and(|fields| {
                    fields.iter().any(|requested_field| requested_field.as_str() == Some(field))
                })
            });
            if !level_requested {
                continue;
            }
            if let Some(level) = status.get(name).and_then(|fan| fan.get(field))
                .and_then(Value::as_f64).filter(|level| (0.0..=1.0).contains(level))
            {
                let mut observed = serde_json::Map::new();
                observed.insert(field.into(), serde_json::json!(level));
                fans.insert(name.clone(), Value::Object(observed));
            }
        }
        if !fans.is_empty() {
            // Explicit readback already obtained the actual value. Keep the
            // headless cache coherent so its next snapshot cannot replay the
            // old fan percentage over the UI's newly confirmed value. Only
            // requested fan fields are merged; heater/job ages stay intact.
            merge_json(&mut self.snapshot.cached_status, Value::Object(fans));
            self.mark_snapshot_dirty();
        }
    }

    fn confirm_operation(
        &mut self,
        request: &OperationRequest,
        result: Value,
        recovered: bool,
    ) -> Result<OperationResult, String> {
        let state = if recovered {
            OperationState::Recovered
        } else {
            OperationState::Confirmed
        };
        self.journal.transition(
            &request.operation_id,
            state,
            now_ms(),
            Some(&result),
            None,
            false,
        )?;
        self.remember_fan_query_result(request, &result);
        if request.method == "printer.print.start" {
            self.phase_from_cached_status();
        } else if matches!(
            request.method.as_str(),
            "printer.print.cancel" | "printer.print.resume" | "printer.print.pause"
        ) {
            self.force_reconcile = true;
        } else {
            self.phase_from_cached_status();
        }
        self.publish_snapshot(
            "operation_result",
            None,
            Some(serde_json::json!({"operationId":request.operation_id,"state":state})),
        );
        Ok(OperationResult {
            operation_id: request.operation_id.clone(),
            session_epoch: self.snapshot.session_epoch,
            state,
            recovered,
            result,
        })
    }

    fn reconcile_status(&mut self) -> Result<Value, String> {
        self.last_reconcile = Instant::now();
        self.force_reconcile = false;
        let fan_names = self
            .fan_catalogue
            .as_ref()
            .filter(|catalogue| {
                catalogue.host == self.config.host
                    && catalogue.default_port == self.config.default_port
            })
            .map(|catalogue| catalogue.names.clone())
            .unwrap_or_default();
        let params = telemetry_reconcile_params(&fan_names);
        let scheduler = Arc::clone(&self.scheduler);
        let mut permit = scheduler.acquire_for_printer(
            &self.config.stable_id,
            OperationPriority::Telemetry,
            Duration::from_secs(15),
        )?;
        let active_host = self
            .active_host()
            .unwrap_or_else(|_| self.config.host.clone());
        let result = self.transport_rpc(
            active_host.clone(),
            "printer.objects.query",
            Some(params),
            true,
            5_000,
            OperationPriority::Telemetry,
            kf_moonraker::CancellationToken::default(),
        );
        if result.is_err() && !fan_names.is_empty() {
            // A few vendor forks advertise an optional fan object but reject
            // it in grouped queries. Preserve the existing core fallback and
            // omit optional objects from subsequent periodic reconciliations.
            self.fan_catalogue = None;
        }
        let result = result.or_else(|_| {
            self.transport_rpc(
                active_host,
                "printer.objects.query",
                Some(serde_json::json!({"objects":{"print_stats":null,"virtual_sdcard":null,"webhooks":null}})),
                false,
                5_000,
                OperationPriority::Telemetry,
                kf_moonraker::CancellationToken::default(),
            )
        });
        if result.is_ok() {
            permit.success();
        }
        let value = result?;
        self.apply_query_status(&value, "rest_reconcile");
        let mut merged = extract_status(&value).unwrap_or_else(|| value.clone());

        // A few vendor forks return HTTP 200 for a grouped object query while
        // silently omitting print_stats or virtual_sdcard.  Treat that as a
        // partial response and repair the job group separately.  This keeps a
        // working printer from showing "job data unavailable" indefinitely.
        let has_job = [
            "/print_stats/state",
            "/print_stats/filename",
            "/virtual_sdcard/progress",
        ]
        .iter()
        .any(|path| merged.pointer(path).is_some_and(|item| !item.is_null()));
        if !has_job {
            let job_params = Some(serde_json::json!({"objects":{"print_stats":null,"virtual_sdcard":null}}));
            let active_host = self
                .active_host()
                .unwrap_or_else(|_| self.config.host.clone());
            let repair = self
                .transport_rpc(
                    active_host.clone(),
                    "printer.objects.query",
                    job_params.clone(),
                    true,
                    3_000,
                    OperationPriority::Telemetry,
                    kf_moonraker::CancellationToken::default(),
                )
                .or_else(|_| {
                    self.transport_rpc(
                        active_host,
                        "printer.objects.query",
                        job_params,
                        false,
                        3_000,
                        OperationPriority::Telemetry,
                        kf_moonraker::CancellationToken::default(),
                    )
                });
            if let Ok(repair_value) = repair {
                self.apply_query_status(&repair_value, "rest_reconcile");
                if let Some(repair_status) = extract_status(&repair_value) {
                    merge_json(&mut merged, repair_status);
                }
            }
        }
        self.repair_missing_temperatures(&mut merged);
        Ok(merged)
    }

    fn repair_missing_temperatures(&mut self, merged: &mut Value) {
        // A grouped query may succeed with live job data but silently omit one
        // or both heaters. The job-only compatibility fallback also omits them.
        // Repair this response, never the cached snapshot, using at most two
        // read-only queries. Healthy complete responses add no requests.
        let active_host = self
            .active_host()
            .unwrap_or_else(|_| self.config.host.clone());
        for prefer_rest in [true, false] {
            let missing = missing_temperature_objects(merged);
            if missing.is_empty() {
                break;
            }
            let objects = missing
                .iter()
                .map(|heater| ((*heater).to_string(), Value::Null))
                .collect::<serde_json::Map<_, _>>();
            let result = self.transport_rpc(
                active_host.clone(),
                "printer.objects.query",
                Some(serde_json::json!({"objects":objects})),
                prefer_rest,
                3_000,
                OperationPriority::Telemetry,
                kf_moonraker::CancellationToken::default(),
            );
            let Some(status) = result.ok().and_then(|value| extract_status(&value)) else {
                continue;
            };
            // Some forks ignore the requested object selection. Only real
            // readings for the requested heaters enter this repair; job/fan
            // responses and malformed values cannot claim heater freshness.
            let repaired = missing
                .iter()
                .filter(|heater| observed_temperature(&status, heater).is_some())
                .filter_map(|heater| status.get(*heater).map(|value| ((*heater).to_string(), value.clone())))
                .collect::<serde_json::Map<_, _>>();
            if !repaired.is_empty() {
                let status = Value::Object(repaired);
                self.apply_status(status.clone(), None, "rest_reconcile");
                merge_json(merged, status);
            }
        }
    }

    fn recover_journal(&mut self) {
        if self.recovered_epoch == Some(self.snapshot.session_epoch) {
            return;
        }
        self.recovered_epoch = Some(self.snapshot.session_epoch);
        let records = match self.journal.recoverable(&self.config.stable_id) {
            Ok(records) => records,
            Err(error) => {
                self.force_quarantine_with_kind(
                    format!(
                        "JOURNAL_CORRUPTION: восстановление команд остановлено безопасно: {error}"
                    ),
                    "journal_corruption_quarantined",
                );
                return;
            }
        };
        if records.is_empty() {
            return;
        }
        self.set_phase(PrinterPhase::Recovering);
        let actual = self.reconcile_status().ok();
        for record in records {
            self.recover_record(&record, actual.as_ref());
        }
        self.phase_from_cached_status();
        self.publish_snapshot("journal_recovered", None, None);
    }

    fn recover_record(&mut self, record: &JournalRecord, actual: Option<&Value>) {
        if matches!(
            record.state,
            OperationState::Created | OperationState::Queued
        ) {
            let _ = self.journal.transition(
                &record.operation_id,
                OperationState::Cancelled,
                now_ms(),
                actual,
                Some("Операция не была отправлена до перезапуска"),
                false,
            );
            return;
        }
        let request = OperationRequest {
            operation_id: record.operation_id.clone(),
            method: record.method.clone(),
            params: record.params.clone(),
            priority: record.priority,
            repeat_policy: record.repeat_policy,
            prefer_rest: false,
            timeout_ms: 8_000,
            deadline_at_ms: if record.deadline_at_ms > now_ms() {
                record.deadline_at_ms
            } else {
                now_ms().saturating_add(8_000)
            },
            expected_session_epoch: None,
        };
        if actual.is_some_and(|status| operation_observed(&request, status)) {
            let _ = self.journal.transition(
                &record.operation_id,
                OperationState::Recovered,
                now_ms(),
                actual,
                Some("Результат восстановлен после перезапуска"),
                false,
            );
            return;
        }
        if record.deadline_at_ms > 0 && record.deadline_at_ms <= now_ms() {
            let _ = self.journal.transition(
                &record.operation_id,
                OperationState::Unknown,
                now_ms(),
                actual,
                Some("Сквозной срок операции истёк; автоматический повтор запрещён"),
                false,
            );
            return;
        }
        let may_retry = match record.repeat_policy {
            RepeatPolicy::Safe => true,
            RepeatPolicy::VerifyState => {
                actual.is_some_and(|status| retry_is_safe(&request, status))
            }
            RepeatPolicy::Never => false,
        };
        if may_retry {
            match self.send_once(&request, &Arc::new(AtomicBool::new(false))) {
                Ok(result) => {
                    let _ = self.journal.transition(
                        &record.operation_id,
                        OperationState::Recovered,
                        now_ms(),
                        Some(&result),
                        Some("Безопасно повторено после сверки"),
                        false,
                    );
                }
                Err(error) => {
                    let _ = self.journal.transition(
                        &record.operation_id,
                        OperationState::Unknown,
                        now_ms(),
                        actual,
                        Some(&format!(
                            "Повтор после восстановления не подтверждён: {error}"
                        )),
                        false,
                    );
                }
            }
            return;
        }
        let reason = if record.repeat_policy == RepeatPolicy::Never {
            "Автоповтор запрещён политикой операции"
        } else {
            "Фактическое состояние не доказывает безопасность повтора"
        };
        let _ = self.journal.transition(
            &record.operation_id,
            OperationState::Unknown,
            now_ms(),
            actual,
            Some(reason),
            false,
        );
    }

    fn connection_failed(&mut self, error: String) {
        if let Some(websocket) = self.websocket.take() {
            websocket.close();
        }
        self.snapshot.connected = false;
        self.snapshot.active_protocol = "disconnected".into();
        self.snapshot.last_error = Some(error.chars().take(512).collect());
        self.snapshot.reconnect_attempt = self.snapshot.reconnect_attempt.saturating_add(1);
        if self.snapshot.phase != PrinterPhase::Quarantined {
            if self.snapshot.phase == PrinterPhase::Degraded {
                self.set_phase(PrinterPhase::Recovering);
            } else {
                self.set_phase(PrinterPhase::Degraded);
            }
        }
        let jitter = stable_jitter(&self.config.stable_id, self.snapshot.reconnect_attempt) % 750;
        let delay = if authorization_failure(&error) {
            AUTHORIZATION_RECONNECT_DELAY
        } else {
            let exponent = self.snapshot.reconnect_attempt.min(7);
            Duration::from_secs((1_u64 << exponent).min(MAX_RECONNECT_DELAY.as_secs()))
        };
        self.reconnect_at = Instant::now() + delay + Duration::from_millis(jitter);
        self.persist_snapshot();
        self.publish_snapshot("connection_failed", None, None);
    }

    fn set_phase(&mut self, phase: PrinterPhase) {
        if self.machine.phase() == PrinterPhase::Quarantined && phase != PrinterPhase::Identifying {
            return;
        }
        if self.machine.transition(phase).is_ok() {
            self.snapshot.phase = self.machine.phase();
        }
    }

    fn update_queue_size(&mut self) {
        self.snapshot.queued_operations = self.queue.len();
        self.sync_shared_snapshot();
    }

    fn sync_shared_snapshot(&self) {
        if let Ok(mut shared) = self.shared_snapshot.lock() {
            *shared = self.snapshot.clone();
            shared.update_blocking_operations = Some(self.queue.iter()
                .filter(|operation| classify_method(&operation.request.method).1 != OperationPriority::Telemetry)
                .count() + usize::from(self.active_update_operation));
        }
    }

    fn record_trace(&mut self, direction: &str, frame: Value) {
        let trace_id = self
            .snapshot
            .active_operation_id
            .clone()
            .unwrap_or_else(|| {
                format!(
                    "session-{}-{}",
                    short_id(&self.snapshot.stable_id),
                    self.snapshot.session_epoch
                )
            });
        let sequence = self.trace_sequence;
        self.trace_sequence = self.trace_sequence.saturating_add(1);
        let _ = self.journal.record_frame(
            &trace_id,
            &self.snapshot.stable_id,
            direction,
            sequence,
            frame,
            now_ms(),
        );
    }

    fn persist_snapshot(&mut self) {
        self.sync_shared_snapshot();
        let _ = self.journal.save_actor_state(
            &self.snapshot.stable_id,
            &self.snapshot.printer_id,
            self.snapshot.model_id.as_deref(),
            &self.snapshot.host,
            self.snapshot.active_port,
            self.snapshot.session_epoch,
            self.snapshot.phase,
            self.snapshot.capabilities.firmware_signature.as_deref(),
            &self.snapshot.capabilities,
            &self.snapshot.cached_status,
            self.snapshot.last_eventtime,
            self.snapshot.last_seen_at,
            now_ms(),
        );
        self.snapshot_dirty = false;
        self.last_snapshot_persist = Instant::now();
    }

    fn mark_snapshot_dirty(&mut self) {
        self.snapshot_dirty = true;
        self.flush_snapshot_if_due(false);
    }

    fn flush_snapshot_if_due(&mut self, force: bool) {
        if self.snapshot_dirty
            && (force || self.last_snapshot_persist.elapsed() >= SNAPSHOT_PERSIST_INTERVAL)
        {
            self.persist_snapshot();
        }
    }

    fn publish_snapshot(&self, kind: &str, status: Option<Value>, payload: Option<Value>) {
        self.sync_shared_snapshot();
        let mut event = ActorEvent {
            event_id: 0,
            stable_id: self.snapshot.stable_id.clone(),
            printer_id: self.snapshot.printer_id.clone(),
            session_epoch: self.snapshot.session_epoch,
            kind: kind.to_string(),
            phase: self.snapshot.phase,
            eventtime: self.snapshot.last_eventtime,
            telemetry_updated_at: self.snapshot.telemetry_updated_at,
            nozzle_updated_at: self.snapshot.nozzle_updated_at,
            bed_updated_at: self.snapshot.bed_updated_at,
            job_updated_at: self.snapshot.job_updated_at,
            status,
            operation_id: self.snapshot.active_operation_id.clone(),
            payload,
        };
        let lifecycle = matches!(kind, "klippy_ready" | "klippy_shutdown" | "klippy_disconnected" | "printer_fault");
        if event.status.is_some() && !lifecycle {
            // High-frequency telemetry is recoverable from the compacted actor
            // snapshot.  It stays live but does not amplify SQLite/outbox ACK
            // traffic. Command and lifecycle events below remain durable.
            self.event_sink.emit(event);
        } else if let Ok(event_id) = self.journal.append_event(&event, now_ms()) {
            event.event_id = event_id;
            self.event_sink.emit(event);
        }
    }
}

fn transient_attestation_quarantine(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| {
        reason.contains("IDENTITY_EVIDENCE_UNAVAILABLE")
            || reason.contains("Аттестация v6 не подтвердила")
    })
}

fn connection_observation_stale(last_seen_at: Option<i64>, observed_at: i64) -> bool {
    last_seen_at.is_none_or(|seen| {
        observed_at.saturating_sub(seen) >= CONNECTION_STALE_RECONNECT_MS
    })
}

fn merge_json(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                if let Some(current) = target.get_mut(&key) {
                    merge_json(current, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (target, patch) => *target = patch,
    }
}

fn extract_status(value: &Value) -> Option<Value> {
    value
        .get("status")
        .or_else(|| value.pointer("/result/status"))
        .cloned()
}

fn camera_guarded_pause(request: &OperationRequest) -> bool {
    request.method == "printer.print.pause"
        && request.params.as_ref().is_some_and(|params| params.get("_cameraGuard").is_some())
}

struct CameraPauseGuard {
    filename: String,
    minimum_print_duration: f64,
    requested_at_ms: i64,
    max_age_ms: i64,
}

impl CameraPauseGuard {
    fn matches(&self, status: &Value, now: i64, paused: bool) -> bool {
        let stats = status.get("print_stats");
        let state = stats.and_then(|value| value.get("state")).and_then(Value::as_str);
        let filename = stats.and_then(|value| value.get("filename")).and_then(Value::as_str);
        let duration = stats.and_then(|value| value.get("print_duration")).and_then(Value::as_f64);
        let age = now.saturating_sub(self.requested_at_ms);
        state == Some(if paused { "paused" } else { "printing" })
            && filename == Some(self.filename.as_str())
            && (-2_000..=self.max_age_ms).contains(&age)
            && duration.is_some_and(|duration| duration.is_finite()
                && duration >= self.minimum_print_duration - 2.0
                && duration <= self.minimum_print_duration + age.max(0) as f64 / 1_000.0 + 10.0)
    }
}

fn camera_pause_guard(request: &OperationRequest, now: i64) -> Result<Option<CameraPauseGuard>, String> {
    if !camera_guarded_pause(request) { return Ok(None); }
    let invalid = || "CAMERA_GUARD_BLOCKED: некорректная или устаревшая проверка камеры".to_string();
    let params = request.params.as_ref().and_then(Value::as_object).ok_or_else(invalid)?;
    let value = params.get("_cameraGuard").and_then(Value::as_object).ok_or_else(invalid)?;
    if params.len() != 1 || value.len() != 4 { return Err(invalid()); }
    let filename = value.get("filename").and_then(Value::as_str).ok_or_else(invalid)?;
    let minimum_print_duration = value.get("minimumPrintDuration").and_then(Value::as_f64).ok_or_else(invalid)?;
    let requested_at_ms = value.get("requestedAtMs").and_then(Value::as_i64).ok_or_else(invalid)?;
    let max_age_ms = value.get("maxAgeMs").and_then(Value::as_i64).ok_or_else(invalid)?;
    let age = now.saturating_sub(requested_at_ms);
    if filename.is_empty() || filename.len() > 2048 || filename.chars().any(char::is_control)
        || !minimum_print_duration.is_finite() || minimum_print_duration < 60.0
        || requested_at_ms <= 0 || !(1..=10_000).contains(&max_age_ms)
        || !(-2_000..=max_age_ms).contains(&age)
    { return Err(invalid()); }
    Ok(Some(CameraPauseGuard {filename: filename.into(), minimum_print_duration, requested_at_ms, max_age_ms}))
}

fn operation_observed(request: &OperationRequest, status: &Value) -> bool {
    let state = status
        .pointer("/print_stats/state")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match request.method.as_str() {
        "printer.print.start" => {
            let expected = request
                .params
                .as_ref()
                .and_then(|params| params.get("filename"))
                .and_then(Value::as_str);
            let actual = status
                .pointer("/print_stats/filename")
                .and_then(Value::as_str);
            matches!(state.as_str(), "printing" | "paused")
                && expected.is_some_and(|name| !name.is_empty() && Some(name) == actual)
        }
        "printer.print.pause" => state == "paused",
        "printer.print.resume" => state == "printing",
        "printer.print.cancel" => !matches!(state.as_str(), "printing" | "paused"),
        "printer.emergency_stop" => status
            .pointer("/webhooks/state")
            .and_then(Value::as_str)
            .is_some_and(|value| matches!(value, "shutdown" | "error")),
        _ => false,
    }
}

fn retry_is_safe(request: &OperationRequest, status: &Value) -> bool {
    let state = status
        .pointer("/print_stats/state")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match request.method.as_str() {
        // A completed job is also idle. Therefore a negative live-state check
        // cannot prove that a previously sent start was never executed.
        "printer.print.start" => false,
        "printer.print.pause" => state == "printing",
        "printer.print.resume" => state == "paused",
        "printer.print.cancel" => matches!(state.as_str(), "printing" | "paused"),
        _ => false,
    }
}

fn ambiguous_transport_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "timeout",
        "timed out",
        "connect failed",
        "connection reset",
        "connection aborted",
        "broken pipe",
        "closed the websocket",
        "response failed",
        "unexpected eof",
        "worker failed",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn authorization_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("api key")
        || lower.contains("api_key")
}

fn stable_jitter(stable_id: &str, attempt: u32) -> u64 {
    stable_id.bytes().fold(attempt as u64, |hash, byte| {
        hash.wrapping_mul(109).wrapping_add(byte as u64)
    })
}

fn target_for_port(host: &str, default_port: u16, port: u16) -> Result<HttpTarget, String> {
    if port == 0 {
        return Err("Недопустимый активный порт PrinterActor".into());
    }
    let parsed = parse_target(host, default_port)?;
    let socket =
        match parsed.socket {
            std::net::SocketAddr::V4(value) => {
                std::net::SocketAddr::new(std::net::IpAddr::V4(*value.ip()), port)
            }
            std::net::SocketAddr::V6(value) => std::net::SocketAddr::V6(
                std::net::SocketAddrV6::new(*value.ip(), port, value.flowinfo(), value.scope_id()),
            ),
        };
    let authority = match socket {
        std::net::SocketAddr::V4(value) => value.to_string(),
        std::net::SocketAddr::V6(value) if value.scope_id() > 0 => {
            format!("[{}%{}]:{}", value.ip(), value.scope_id(), value.port())
        }
        std::net::SocketAddr::V6(value) => format!("[{}]:{}", value.ip(), value.port()),
    };
    Ok(HttpTarget { authority, socket })
}

fn active_actor_config(config: &ActorConfig, port: u16) -> Result<ActorConfig, String> {
    let target = target_for_port(&config.host, config.default_port, port)?;
    let mut active = config.clone();
    active.host = target.authority;
    active.default_port = port;
    Ok(active)
}

fn short_id(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(16)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn authorization_failures_are_classified_for_slow_reconnect() {
        assert!(authorization_failure("Moonraker HTTP error: 401"));
        assert!(authorization_failure("API_KEY rejected"));
        assert!(!authorization_failure("connection timed out"));
    }

    #[test]
    fn stale_connection_observation_has_bounded_reconnect_deadline() {
        let now = 100_000;
        assert!(!connection_observation_stale(Some(now - 29_999), now));
        assert!(connection_observation_stale(Some(now - 30_000), now));
        assert!(connection_observation_stale(None, now));
    }

    #[test]
    fn only_transient_attestation_quarantine_is_automatically_retried() {
        assert!(transient_attestation_quarantine(Some(
            "IDENTITY_EVIDENCE_UNAVAILABLE: temporary timeout"
        )));
        assert!(transient_attestation_quarantine(Some(
            "Аттестация v6 не подтвердила virtual_sdcard"
        )));
        assert!(!transient_attestation_quarantine(Some(
            "IDENTITY_MISMATCH: другой принтер"
        )));
        assert!(!transient_attestation_quarantine(Some(
            "ACTOR_CRASH_LOOP: manual review required"
        )));
    }

    #[derive(Default)]
    struct NoopTransport;

    #[test]
    fn restarted_actor_ignores_old_outbox_generation_and_rejects_old_commands() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("kf-restart-epoch-{}-{nonce}.sqlite3", std::process::id()));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        connection.execute_batch(
            "INSERT INTO ui_event_outbox(stable_id,printer_id,session_epoch,kind,phase,status_json,created_at)
                 VALUES('epoch-restart','epoch-restart',48,'connected','printing','{\"print_stats\":{\"state\":\"printing\",\"filename\":\"old.gcode\"}}',1);"
        ).unwrap();
        drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id: "epoch-restart".into(), printer_id: "epoch-restart".into(),
            model_id: Some("custom".into()), host: "127.0.0.1:7125".into(),
            default_port: 7125, api_key: None, firmware_signature: None, capabilities_hint: None,
        };
        let mut initial = ActorSnapshot::new(&config);
        initial.session_epoch = journal.reserve_actor_session_epoch(&config, 0).unwrap();
        let shared = Arc::new(Mutex::new(initial));
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let mut actor = PrinterActor::new(ActorEventSink::headless(), config, sender, receiver,
            Arc::clone(&shared), Arc::new(Mutex::new(HashMap::new())), journal.clone(),
            Arc::new(FarmScheduler::default()), EngineRuntime::new().unwrap(), Arc::new(NoopTransport));
        actor.start();
        let fresh = shared.lock().unwrap().clone();
        assert!(fresh.session_epoch > 48);
        assert!(fresh.cached_status.as_object().unwrap().is_empty());
        assert!(fresh.last_seen_at.is_none());
        let old_events = journal.pending_events("epoch-restart", 32).unwrap();
        assert!(old_events.iter().any(|event| event.session_epoch == 48));
        assert!(old_events.iter().any(|event| event.kind == "created" && event.session_epoch > 48));
        let mut old_command = request("printer.gcode.script", Some(serde_json::json!({"script":"G28"})));
        old_command.expected_session_epoch = Some(48);
        let (reply, response) = mpsc::channel();
        assert!(actor.handle_message(ActorMessage::Operation {
            request: old_command, cancelled: Arc::new(AtomicBool::new(false)), reply,
        }));
        assert!(response.recv().unwrap().unwrap_err().starts_with("STALE_SESSION:"));
        assert!(actor.queue.is_empty());
        drop(actor); drop(shared); drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn physical_address_change_discards_old_telemetry_but_port_failover_preserves_it() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("kf-target-reset-{}-{nonce}.sqlite3", std::process::id()));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id: "target-reset".into(), printer_id: "target-reset".into(),
            model_id: Some("custom".into()), host: "127.0.0.1:7125".into(),
            default_port: 7125, api_key: None, firmware_signature: None, capabilities_hint: None,
        };
        let shared = Arc::new(Mutex::new(ActorSnapshot::new(&config)));
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let mut actor = PrinterActor::new(ActorEventSink::headless(), config.clone(), sender, receiver,
            Arc::clone(&shared), Arc::new(Mutex::new(HashMap::new())), journal.clone(),
            Arc::new(FarmScheduler::default()), EngineRuntime::new().unwrap(), Arc::new(NoopTransport));
        actor.snapshot.connected = true;
        actor.snapshot.cached_status = serde_json::json!({"extruder":{"temperature":249},"print_stats":{"state":"printing","filename":"old-device.gcode"}});
        actor.snapshot.last_seen_at = Some(100);
        actor.snapshot.telemetry_updated_at = Some(100);
        actor.snapshot.nozzle_updated_at = Some(100);
        actor.snapshot.bed_updated_at = Some(100);
        actor.snapshot.job_updated_at = Some(100);
        let machine = serde_json::json!({"machine_id":"old-physical-machine"});
        actor.snapshot.identity_attestation = Some(identity::attest("target-reset",Some(&machine),None,None,100));
        let mut changed = config.clone();
        changed.host = "127.0.0.2:7125".into();
        let reset = actor.reconfigure(changed.clone()).unwrap();
        assert!(!reset.connected);
        assert!(reset.cached_status.as_object().unwrap().is_empty());
        assert!(reset.last_seen_at.is_none());
        assert!(reset.telemetry_updated_at.is_none());
        assert!(reset.nozzle_updated_at.is_none());
        assert!(reset.bed_updated_at.is_none());
        assert!(reset.job_updated_at.is_none());
        assert!(reset.identity_attestation.is_none());
        actor.apply_status(serde_json::json!({"extruder":{"temperature":22},"print_stats":{"state":"standby"}}),None,"rest_reconcile");
        let current_status = actor.snapshot.cached_status.clone();
        let current_seen = actor.snapshot.last_seen_at;
        let current_nozzle_at = actor.snapshot.nozzle_updated_at;
        let current_bed_at = actor.snapshot.bed_updated_at;
        assert!(actor.snapshot.telemetry_updated_at.is_none(), "The new bed has not been observed");
        changed.host = "127.0.0.2:80".into();
        changed.default_port = 80;
        let failover = actor.reconfigure(changed).unwrap();
        assert_eq!(failover.cached_status,current_status);
        assert_eq!(failover.last_seen_at,current_seen);
        assert_eq!(failover.nozzle_updated_at,current_nozzle_at);
        assert_eq!(failover.bed_updated_at,current_bed_at);
        drop(actor); drop(shared); drop(journal);
        let _ = std::fs::remove_file(path);
    }

    impl MoonrakerTransport for NoopTransport {
        fn rpc(
            &self,
            _request: MoonrakerRpcRequest,
        ) -> Result<Value, crate::core_error::CoreError> {
            Err(crate::core_error::CoreError::from_legacy(
                "TEST_TRANSPORT_UNUSED",
            ))
        }

        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot {
            Default::default()
        }
    }

    fn request(method: &str, params: Option<Value>) -> OperationRequest {
        OperationRequest {
            operation_id: "op".into(),
            method: method.into(),
            params,
            priority: OperationPriority::Control,
            repeat_policy: RepeatPolicy::VerifyState,
            prefer_rest: false,
            timeout_ms: 8_000,
            deadline_at_ms: now_ms().saturating_add(8_000),
            expected_session_epoch: None,
        }
    }

    #[test]
    fn fan_telemetry_catalogue_is_bounded_and_excludes_automatic_heater_fans() {
        let selected = fan_telemetry_objects([
            "fan", "fan_generic part", "fan_generic part", "fan_generic auxiliary",
            "heater_fan hotend", "temperature_fan chamber", "fan_generic ",
            "fan_generic bad\nname", "extruder", "output_pin fan0", "output_pin chamber_led",
        ]);
        assert_eq!(selected, vec!["fan", "output_pin fan0", "fan_generic auxiliary", "fan_generic part"]);
        let mut names = (0..100).map(|index| format!("fan_generic channel_{index:03}")).collect::<Vec<_>>();
        names.push("fan".into());
        names.push("output_pin fan0".into());
        names.push(format!("fan_generic {}", "x".repeat(300)));
        let bounded = fan_telemetry_objects(names.iter().map(String::as_str));
        assert_eq!(bounded.len(), 64);
        assert_eq!(bounded.first().map(String::as_str), Some("fan"));
        assert_eq!(bounded.get(1).map(String::as_str), Some("output_pin fan0"));
        assert!(bounded.iter().all(|name| name.len() <= 256));
        assert!(fan_telemetry_objects(["heater_fan hotend", "extruder", "output_pin chamber_led"]).is_empty());
    }

    struct FanTelemetryTransport {
        queries: Mutex<Vec<(bool, Value)>>,
        reject_optional_fans: bool,
    }

    impl MoonrakerTransport for FanTelemetryTransport {
        fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, crate::core_error::CoreError> {
            assert_eq!(request.method, "printer.objects.query");
            let params = request.params.expect("status query has objects");
            let objects = params.get("objects").and_then(Value::as_object).unwrap();
            self.queries.lock().unwrap().push((request.prefer_rest, params.clone()));
            if self.reject_optional_fans && objects.contains_key("fan_generic part") {
                return Err(crate::core_error::CoreError::from_legacy("Unknown optional fan object"));
            }
            let available = serde_json::json!({
                "print_stats":{"state":"standby"},
                "virtual_sdcard":{"progress":0},
                "extruder":{"temperature":23.5,"target":0},
                "heater_bed":{"temperature":22.0,"target":0},
                "webhooks":{"state":"ready"},
                "fan":{"speed":0.4},
                "fan_generic part":{"speed":0.73},
                "output_pin fan0":{"value":0.52}
            });
            let status = objects.keys().filter_map(|name| {
                available.get(name).map(|value| (name.clone(), value.clone()))
            }).collect::<serde_json::Map<_, _>>();
            Ok(serde_json::json!({"status":status,"eventtime":1.0}))
        }

        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot { Default::default() }
    }

    #[test]
    fn known_fan_objects_reconcile_actual_speed_alongside_core_telemetry() {
        let transport = Arc::new(FanTelemetryTransport {
            queries: Mutex::new(Vec::new()), reject_optional_fans: false,
        });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        actor.fan_catalogue = Some(FanTelemetryCatalogue {
            host: actor.config.host.clone(), default_port: actor.config.default_port,
            names: fan_telemetry_objects(["fan", "fan_generic part", "output_pin fan0"]),
        });
        actor.reconcile_status().unwrap();
        assert_eq!(actor.snapshot.cached_status.pointer("/fan/speed"), Some(&serde_json::json!(0.4)));
        assert_eq!(actor.snapshot.cached_status.pointer("/fan_generic part/speed"), Some(&serde_json::json!(0.73)));
        assert_eq!(actor.snapshot.cached_status.pointer("/output_pin fan0/value"), Some(&serde_json::json!(0.52)));
        assert!(actor.snapshot.telemetry_updated_at.is_some());
        assert!(actor.snapshot.job_updated_at.is_some());
        let queries = transport.queries.lock().unwrap();
        assert_eq!(queries.len(), 1, "No separate fan polling request is added");
        assert!(queries[0].0);
        assert_eq!(queries[0].1.pointer("/objects/fan"), Some(&serde_json::json!(["speed"])));
        assert_eq!(queries[0].1.pointer("/objects/fan_generic part"), Some(&serde_json::json!(["speed"])));
        assert_eq!(queries[0].1.pointer("/objects/output_pin fan0"), Some(&serde_json::json!(["value"])));
        assert!(queries[0].1.pointer("/objects/extruder").is_some());
        drop(queries); drop(actor); drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejected_optional_fan_preserves_core_fallback_and_next_temperature_query() {
        let transport = Arc::new(FanTelemetryTransport {
            queries: Mutex::new(Vec::new()), reject_optional_fans: true,
        });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        actor.fan_catalogue = Some(FanTelemetryCatalogue {
            host: actor.config.host.clone(), default_port: actor.config.default_port,
            names: vec!["fan_generic part".into()],
        });
        actor.reconcile_status().unwrap();
        assert!(actor.fan_catalogue.is_none());
        assert!(actor.snapshot.connected);
        assert!(actor.snapshot.job_updated_at.is_some());
        assert!(actor.snapshot.cached_status.get("fan_generic part").is_none());
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(23.5)),
            "A rejected optional object must not postpone heater delivery until the next poll");
        actor.reconcile_status().unwrap();
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(23.5)));
        assert!(actor.snapshot.telemetry_updated_at.is_some());
        let queries = transport.queries.lock().unwrap();
        assert_eq!(queries.len(), 4);
        assert_eq!(queries.iter().map(|query| query.0).collect::<Vec<_>>(), vec![true, false, true, true]);
        assert!(queries[2].1.pointer("/objects/fan_generic part").is_none());
        assert!(queries[2].1.pointer("/objects/heater_bed").is_some());
        drop(queries); drop(actor); drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fan_catalogue_from_another_endpoint_never_enters_status_queries() {
        for (host, default_port) in [("192.168.1.99:7125", 7125), ("127.0.0.1:7125", 80)] {
            let transport = Arc::new(FanTelemetryTransport {
                queries: Mutex::new(Vec::new()), reject_optional_fans: false,
            });
            let (mut actor, journal, path) = start_path_actor(transport.clone());
            actor.fan_catalogue = Some(FanTelemetryCatalogue {
                host: host.into(), default_port, names: vec!["fan_generic part".into()],
            });
            actor.reconcile_status().unwrap();
            assert!(actor.snapshot.cached_status.get("fan_generic part").is_none());
            let queries = transport.queries.lock().unwrap();
            assert_eq!(queries.len(), 1);
            assert!(queries[0].1.pointer("/objects/fan_generic part").is_none());
            assert!(queries[0].1.pointer("/objects/print_stats").is_some());
            drop(queries); drop(actor); drop(journal);
            let _ = std::fs::remove_file(path);
        }
    }

    struct TemperatureRepairTransport {
        queries: Mutex<Vec<(bool, Value)>>,
        responses: Mutex<std::collections::VecDeque<Result<Value, &'static str>>>,
    }

    impl MoonrakerTransport for TemperatureRepairTransport {
        fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, crate::core_error::CoreError> {
            assert_eq!(request.method, "printer.objects.query", "Heater repair must remain read-only");
            self.queries.lock().unwrap().push((request.prefer_rest, request.params.unwrap()));
            self.responses.lock().unwrap().pop_front().expect("No unbounded temperature retry")
                .map_err(crate::core_error::CoreError::from_legacy)
        }

        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot { Default::default() }
    }

    #[test]
    fn temperature_numeric_strings_advance_only_actual_core_freshness() {
        let (mut actor, journal, path) = start_path_actor(Arc::new(NoopTransport));
        actor.snapshot.telemetry_updated_at = Some(123);
        actor.snapshot.job_updated_at = Some(456);
        actor.apply_status(serde_json::json!({
            "extruder":{"temperature":"219.5","target":"220"},
            "heater_bed":{"temperature":"60.0","target":"60"}
        }), None, "rest_reconcile");
        assert!(actor.snapshot.telemetry_updated_at.is_some_and(|at| at > 123));
        assert_eq!(actor.snapshot.nozzle_updated_at, actor.snapshot.telemetry_updated_at);
        assert_eq!(actor.snapshot.bed_updated_at, actor.snapshot.telemetry_updated_at);
        assert_eq!(actor.snapshot.job_updated_at, Some(456));
        actor.snapshot.telemetry_updated_at = Some(123);
        actor.snapshot.nozzle_updated_at = Some(123);
        actor.snapshot.bed_updated_at = Some(123);
        for value in [Value::Null, serde_json::json!("NaN"), serde_json::json!("Infinity"), serde_json::json!("unknown")] {
            actor.apply_status(serde_json::json!({"extruder":{"temperature":value}}), None, "rest_reconcile");
            assert_eq!(actor.snapshot.telemetry_updated_at, Some(123));
            assert_eq!(actor.snapshot.nozzle_updated_at, Some(123));
            assert_eq!(actor.snapshot.bed_updated_at, Some(123));
        }
        actor.apply_status(serde_json::json!({"print_stats":{"state":"printing"},"virtual_sdcard":{"progress":0.02}}), None, "rest_reconcile");
        assert!(actor.snapshot.job_updated_at.is_some_and(|at| at > 456));
        assert_eq!(actor.snapshot.telemetry_updated_at, Some(123));
        actor.apply_status(serde_json::json!({"fan":{"speed":0.5},"extruder":{"target":220}}), None, "rest_reconcile");
        assert_eq!(actor.snapshot.telemetry_updated_at, Some(123));
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn temperature_partial_heater_delta_keeps_other_heater_provenance() {
        let (mut actor, journal, path) = start_path_actor(Arc::new(NoopTransport));
        actor.snapshot.cached_status = serde_json::json!({"extruder":{"temperature":210},"heater_bed":{"temperature":50}});
        actor.snapshot.nozzle_updated_at = Some(123);
        actor.snapshot.bed_updated_at = Some(456);
        actor.apply_status(serde_json::json!({"heater_bed":{"temperature":"60.5"}}), Some(1.0), "websocket");
        assert_eq!(actor.snapshot.nozzle_updated_at, Some(123));
        assert!(actor.snapshot.bed_updated_at.is_some_and(|at| at > 456));
        assert_eq!(actor.snapshot.telemetry_updated_at, Some(123), "A bed delta cannot refresh the cached nozzle");
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(210)));
        let bed_at = actor.snapshot.bed_updated_at;
        actor.apply_status(serde_json::json!({"extruder":{"temperature":219.5}}), Some(2.0), "websocket");
        assert!(actor.snapshot.nozzle_updated_at.is_some_and(|at| at > 123));
        assert_eq!(actor.snapshot.bed_updated_at, bed_at);
        assert_eq!(actor.snapshot.telemetry_updated_at, bed_at, "Overall freshness follows the older actual observation");
        let snapshot_json = serde_json::to_value(&actor.snapshot).unwrap();
        assert_eq!(snapshot_json.get("nozzleUpdatedAt"), Some(&serde_json::json!(actor.snapshot.nozzle_updated_at)));
        assert_eq!(snapshot_json.get("bedUpdatedAt"), Some(&serde_json::json!(bed_at)));
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn temperature_repair_restores_heaters_after_job_only_grouped_reply() {
        let transport = Arc::new(TemperatureRepairTransport {
            queries: Mutex::new(Vec::new()),
            responses: Mutex::new(std::collections::VecDeque::from([
                Ok(serde_json::json!({"status":{"print_stats":{"state":"printing","filename":"part.gcode"},"virtual_sdcard":{"progress":0.02}},"eventtime":42})),
                Ok(serde_json::json!({"status":{"extruder":{"temperature":"219.5","target":220},"heater_bed":{"temperature":60,"target":60}},"eventtime":42})),
            ])),
        });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        actor.snapshot.cached_status = serde_json::json!({"extruder":{"temperature":21},"heater_bed":{"temperature":20}});
        actor.snapshot.telemetry_updated_at = Some(123);
        let status = actor.reconcile_status().unwrap();
        assert_eq!(status.pointer("/extruder/temperature"), Some(&serde_json::json!("219.5")));
        assert_eq!(status.pointer("/heater_bed/temperature"), Some(&serde_json::json!(60)));
        assert_eq!(actor.snapshot.cached_status.pointer("/virtual_sdcard/progress"), Some(&serde_json::json!(0.02)));
        assert!(actor.snapshot.telemetry_updated_at.is_some_and(|at| at > 123));
        assert!(actor.snapshot.nozzle_updated_at.is_some());
        assert!(actor.snapshot.bed_updated_at.is_some());
        assert!(actor.snapshot.job_updated_at.is_some());
        let queries = transport.queries.lock().unwrap();
        assert_eq!(queries.len(), 2);
        assert!(queries[0].0 && queries[1].0);
        assert_eq!(queries[1].1, serde_json::json!({"objects":{"extruder":null,"heater_bed":null}}));
        drop(queries); drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn temperature_repair_uses_alternate_transport_for_still_missing_heater() {
        let transport = Arc::new(TemperatureRepairTransport {
            queries: Mutex::new(Vec::new()),
            responses: Mutex::new(std::collections::VecDeque::from([
                Err("Vendor rejected grouped telemetry"),
                Ok(serde_json::json!({"status":{"print_stats":{"state":"printing"},"virtual_sdcard":{"progress":0.02}}})),
                Ok(serde_json::json!({"status":{"extruder":{"temperature":219.5},"heater_bed":{"temperature":"NaN"},"fan":{"speed":0.9},"print_stats":{"state":"error"}}})),
                Ok(serde_json::json!({"result":{"status":{"heater_bed":{"temperature":"60.5"},"extruder":{"temperature":999}}}})),
            ])),
        });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        let status = actor.reconcile_status().unwrap();
        assert_eq!(status.pointer("/extruder/temperature"), Some(&serde_json::json!(219.5)));
        assert_eq!(status.pointer("/heater_bed/temperature"), Some(&serde_json::json!("60.5")));
        assert_eq!(status.pointer("/print_stats/state"), Some(&serde_json::json!("printing")));
        assert!(actor.snapshot.cached_status.get("fan").is_none());
        let queries = transport.queries.lock().unwrap();
        assert_eq!(queries.iter().map(|query| query.0).collect::<Vec<_>>(), vec![true, false, true, false]);
        assert_eq!(queries[3].1, serde_json::json!({"objects":{"heater_bed":null}}));
        drop(queries); drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn temperature_repair_failure_keeps_stale_readings_and_freshness_honest() {
        let transport = Arc::new(TemperatureRepairTransport {
            queries: Mutex::new(Vec::new()),
            responses: Mutex::new(std::collections::VecDeque::from([
                Ok(serde_json::json!({"status":{"print_stats":{"state":"printing"},"virtual_sdcard":{"progress":0.02}}})),
                Ok(serde_json::json!({"status":{"extruder":{"temperature":"Infinity"},"heater_bed":{"target":60},"print_stats":{"state":"error"}}})),
                Err("Heater query unavailable"),
            ])),
        });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        actor.snapshot.cached_status = serde_json::json!({"extruder":{"temperature":21},"heater_bed":{"temperature":20}});
        actor.snapshot.telemetry_updated_at = Some(123);
        actor.snapshot.nozzle_updated_at = Some(123);
        actor.snapshot.bed_updated_at = Some(123);
        actor.reconcile_status().unwrap();
        assert_eq!(actor.snapshot.telemetry_updated_at, Some(123));
        assert_eq!(actor.snapshot.nozzle_updated_at, Some(123));
        assert_eq!(actor.snapshot.bed_updated_at, Some(123));
        assert!(actor.snapshot.job_updated_at.is_some());
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(21)));
        assert_eq!(actor.snapshot.cached_status.pointer("/heater_bed/temperature"), Some(&serde_json::json!(20)));
        assert_eq!(actor.snapshot.cached_status.pointer("/print_stats/state"), Some(&serde_json::json!("printing")));
        assert_eq!(transport.queries.lock().unwrap().len(), 3, "Repair has two bounded read attempts");
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn explicit_fan_readback_updates_cache_without_inventing_other_freshness_or_events() {
        let (mut actor, journal, path) = start_path_actor(Arc::new(NoopTransport));
        actor.snapshot.cached_status = serde_json::json!({
            "print_stats":{"state":"standby"},
            "heater_bed":{"temperature":22.0},
            "fan":{"speed":0.1}, "fan_generic part":{"speed":0.11},
            "output_pin fan0":{"value":0.12}
        });
        actor.snapshot.telemetry_updated_at = Some(123);
        actor.snapshot.job_updated_at = Some(456);
        actor.snapshot.last_seen_at = Some(789);
        actor.remember_fan_query_result(&request("printer.objects.list", None), &serde_json::json!({
            "objects":["fan", "fan_generic part", "heater_fan hotend", "output_pin fan0", "output_pin chamber_led"]
        }));
        let operation = request("printer.objects.query", Some(serde_json::json!({"objects":{"fan":["speed"],"output_pin fan0":["value"]}})));
        journal.create(&actor.config.stable_id, actor.snapshot.session_epoch, &operation, now_ms()).unwrap();
        actor.confirm_operation(&operation, serde_json::json!({"status":{
            "fan":{"speed":0.62}, "fan_generic part":{"speed":0.9},
            "fan_generic unknown":{"speed":0.8}, "heater_bed":{"temperature":999.0},
            "output_pin fan0":{"value":0.42}, "output_pin chamber_led":{"value":1.0}
        }}), false).unwrap();
        let snapshot = actor.shared_snapshot.lock().unwrap().clone();
        assert_eq!(snapshot.cached_status.pointer("/fan/speed"), Some(&serde_json::json!(0.62)));
        assert_eq!(snapshot.cached_status.pointer("/output_pin fan0/value"), Some(&serde_json::json!(0.42)));
        assert_eq!(snapshot.cached_status.pointer("/fan_generic part/speed"), Some(&serde_json::json!(0.11)));
        assert!(snapshot.cached_status.get("fan_generic unknown").is_none());
        assert!(snapshot.cached_status.get("output_pin chamber_led").is_none());
        assert_eq!(snapshot.cached_status.pointer("/heater_bed/temperature"), Some(&serde_json::json!(22.0)));
        assert_eq!(snapshot.telemetry_updated_at, Some(123));
        assert_eq!(snapshot.job_updated_at, Some(456));
        assert_eq!(snapshot.last_seen_at, Some(789));
        assert!(!snapshot.connected);
        let events = journal.pending_events(&actor.config.printer_id, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "operation_result");
        assert!(events[0].status.is_none(), "Readback must not emit a synthetic transport status event");
        for invalid in [Value::Null, serde_json::json!("unknown"), serde_json::json!(1.1), serde_json::json!(-0.1)] {
            actor.remember_fan_query_result(&operation, &serde_json::json!({"status":{"fan":{"speed":invalid.clone()},"output_pin fan0":{"value":invalid}}}));
            assert_eq!(actor.snapshot.cached_status.pointer("/fan/speed"), Some(&serde_json::json!(0.62)));
            assert_eq!(actor.snapshot.cached_status.pointer("/output_pin fan0/value"), Some(&serde_json::json!(0.42)));
        }
        drop(actor); drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn print_start_is_verified_by_filename_and_state() {
        let operation = request(
            "printer.print.start",
            Some(serde_json::json!({"filename":"part.gcode"})),
        );
        let correct =
            serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode"}});
        let other =
            serde_json::json!({"print_stats":{"state":"printing","filename":"other.gcode"}});
        assert!(operation_observed(&operation, &correct));
        assert!(!operation_observed(&operation, &other));
    }

    struct StartAcknowledgementTransport {
        statuses: Mutex<std::collections::VecDeque<Value>>,
        starts: std::sync::atomic::AtomicUsize,
    }

    impl MoonrakerTransport for StartAcknowledgementTransport {
        fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, crate::core_error::CoreError> {
            match request.method.as_str() {
                "printer.print.start" => { self.starts.fetch_add(1, Ordering::Relaxed); Ok(serde_json::json!("ok")) }
                "printer.objects.query" => {
                    let mut statuses = self.statuses.lock().unwrap();
                    let status = if statuses.len() > 1 { statuses.pop_front().unwrap() } else { statuses.front().cloned().unwrap() };
                    Ok(serde_json::json!({"status":status}))
                }
                _ => panic!("unexpected test RPC: {}", request.method),
            }
        }
        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot { Default::default() }
    }

    #[test]
    fn accepted_start_requires_fresh_matching_job_and_is_never_repeated() {
        for (states, confirmed) in [
            (vec![("standby", ""), ("printing", "part.gcode")], true),
            (vec![("paused", "part.gcode")], true),
            (vec![("standby", "")], false),
            (vec![("printing", "other.gcode")], false),
            (vec![("printing", "")], false),
        ] {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("kf-start-confirm-{nonce}.sqlite3"));
            let mut connection = rusqlite::Connection::open(&path).unwrap();
            super::super::migrations::migrate(&mut connection, 1).unwrap();
            drop(connection);
            let journal = Journal::new(&path).unwrap();
            let config = ActorConfig {
                stable_id:"start-test".into(),printer_id:"start-test".into(),model_id:Some("custom".into()),
                host:"127.0.0.1:7125".into(),default_port:7125,api_key:None,firmware_signature:None,capabilities_hint:None,
            };
            let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
            let shared = Arc::new(Mutex::new(ActorSnapshot::new(&config)));
            let transport = Arc::new(StartAcknowledgementTransport {
                statuses:Mutex::new(states.into_iter().map(|(state,filename)| serde_json::json!({"print_stats":{"state":state,"filename":filename}})).collect()),
                starts:std::sync::atomic::AtomicUsize::new(0),
            });
            let mut actor = PrinterActor::new(ActorEventSink::headless(), config, sender, receiver, shared,
                Arc::new(Mutex::new(HashMap::new())),journal.clone(),Arc::new(FarmScheduler::default()),
                EngineRuntime::new().unwrap(),transport.clone());
            actor.snapshot.cached_status = serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode"}});
            let mut operation = request("printer.print.start", Some(serde_json::json!({"filename":"part.gcode"})));
            operation.deadline_at_ms = now_ms() + 5_000;
            journal.create("start-test", 0, &operation, now_ms()).unwrap();
            let result = actor.execute_operation(&operation, &Arc::new(AtomicBool::new(false)));
            assert_eq!(result.is_ok(), confirmed, "{result:?}");
            assert_eq!(transport.starts.load(Ordering::Relaxed), 1);
            let state: String = journal.read(|connection| connection.query_row(
                "SELECT state FROM command_journal WHERE operation_id='op'", [], |row| row.get(0)).map_err(|error| error.to_string())).unwrap();
            assert_eq!(state, if confirmed { "confirmed" } else { "unknown" });
            if !confirmed { assert!(result.unwrap_err().contains("PRINT_START_UNCONFIRMED")); }
            drop(actor); drop(journal);
            let _ = std::fs::remove_file(&path);
        }
    }

    struct StartPathRecordingTransport {
        calls: Mutex<Vec<(String, bool)>>,
        printing: bool,
    }

    impl MoonrakerTransport for StartPathRecordingTransport {
        fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, crate::core_error::CoreError> {
            self.calls.lock().unwrap().push((request.method.clone(), request.prefer_rest));
            match request.method.as_str() {
                "printer.print.start" => Ok(serde_json::json!("ok")),
                "printer.objects.query" => Ok(serde_json::json!({"status":{"print_stats":{
                    "state":if self.printing { "printing" } else { "standby" },
                    "filename":if self.printing { "part.gcode" } else { "" }
                }}})),
                _ => panic!("unexpected start-path RPC: {}", request.method),
            }
        }
        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot { Default::default() }
    }

    fn start_path_actor(transport: Arc<dyn MoonrakerTransport>) -> (PrinterActor, Journal, std::path::PathBuf) {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("kf-start-path-{}-{nonce}.sqlite3", std::process::id()));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id:"start-path".into(),printer_id:"start-path".into(),model_id:Some("flashforge-ad5m".into()),
            host:"127.0.0.1:7125".into(),default_port:7125,api_key:None,firmware_signature:None,capabilities_hint:None,
        };
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let shared = Arc::new(Mutex::new(ActorSnapshot::new(&config)));
        let actor = PrinterActor::new(ActorEventSink::headless(), config, sender, receiver, shared,
            Arc::new(Mutex::new(HashMap::new())), journal.clone(), Arc::new(FarmScheduler::default()),
            EngineRuntime::new().unwrap(), transport);
        (actor, journal, path)
    }

    fn fault_test_actor(transport: Arc<dyn MoonrakerTransport>) -> (PrinterActor, Journal, std::path::PathBuf) {
        let (mut actor, journal, path) = start_path_actor(transport);
        actor.machine = PrinterStateMachine::new(PrinterPhase::Ready);
        actor.snapshot.phase = PrinterPhase::Ready;
        actor.snapshot.connected = true;
        actor.snapshot.active_protocol = "websocket".into();
        (actor, journal, path)
    }

    #[test]
    fn klippy_shutdown_keeps_live_transport_and_actual_fault() {
        let (mut actor, journal, path) = fault_test_actor(Arc::new(NoopTransport));
        let message = "Heater extruder not heating at expected rate";
        actor.apply_status(serde_json::json!({"webhooks":{"state":"shutdown","state_message":message},"print_stats":{"state":"printing"}}), Some(900.0), "websocket");
        assert_eq!(actor.snapshot.phase, PrinterPhase::Degraded);
        assert!(actor.snapshot.connected);
        assert_eq!(actor.snapshot.last_error.as_deref(), Some(message));
        let presentation = actor.snapshot.connection_presentation(now_ms());
        assert_eq!(presentation.connection_state, "degraded");
        assert_eq!(presentation.reason, "klipper_shutdown");
        assert_eq!(presentation.message, message);
        actor.apply_status(serde_json::json!({"extruder":{"temperature":41.0}}), Some(901.0), "websocket");
        assert_eq!(actor.snapshot.phase, PrinterPhase::Degraded, "unrelated temperatures cannot clear a firmware fault");
        assert_eq!(actor.snapshot.last_error.as_deref(), Some(message));
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn klippy_ready_resets_clock_and_accepts_new_websocket_generation() {
        let (mut actor, journal, path) = fault_test_actor(Arc::new(NoopTransport));
        actor.apply_status(serde_json::json!({"webhooks":{"state":"ready"},"print_stats":{"state":"printing"}}), Some(900.0), "websocket");
        actor.handle_notification(serde_json::json!({"method":"notify_klippy_shutdown"}));
        assert_eq!(actor.snapshot.phase, PrinterPhase::Degraded);
        actor.handle_notification(serde_json::json!({"method":"notify_klippy_disconnected"}));
        assert_eq!(actor.snapshot.phase, PrinterPhase::Recovering);
        actor.handle_notification(serde_json::json!({"method":"notify_klippy_ready"}));
        assert!(actor.subscription_pending, "ready on the same socket requires a new object subscription");
        assert!(actor.snapshot.last_eventtime.is_none());
        actor.apply_status(serde_json::json!({"extruder":{"temperature":23.0},"print_stats":{"state":"standby"}}), Some(0.5), "websocket");
        actor.apply_status(serde_json::json!({"extruder":{"temperature":24.0}}), Some(0.6), "websocket");
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(24.0)));
        assert_eq!(actor.snapshot.phase, PrinterPhase::Ready);
        assert!(actor.snapshot.last_error.is_none());
        let events = journal.pending_events("start-path", 64).unwrap();
        assert!(events.iter().any(|event| event.kind == "klippy_shutdown" && event.status.as_ref().and_then(|status| status.pointer("/webhooks/state")).and_then(Value::as_str) == Some("shutdown")));
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn klippy_full_query_clock_reset_allows_following_deltas() {
        let (mut actor, journal, path) = fault_test_actor(Arc::new(NoopTransport));
        actor.apply_status(serde_json::json!({"webhooks":{"state":"ready"},"extruder":{"temperature":220.0}}), Some(900.0), "websocket");
        actor.apply_status(serde_json::json!({"webhooks":{"state":"ready"},"extruder":{"temperature":21.0}}), Some(1.0), "rest_reconcile");
        actor.apply_status(serde_json::json!({"extruder":{"temperature":22.0}}), Some(1.1), "websocket");
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(22.0)));
        assert_eq!(actor.snapshot.last_eventtime, Some(1.1));
        actor.apply_status(serde_json::json!({"extruder":{"temperature":999.0}}), Some(1.05), "websocket");
        assert_eq!(actor.snapshot.cached_status.pointer("/extruder/temperature"), Some(&serde_json::json!(22.0)), "out-of-order deltas are still rejected");
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    struct KlippyInfoTestTransport {
        state: &'static str,
        calls: Mutex<Vec<String>>,
    }

    impl MoonrakerTransport for KlippyInfoTestTransport {
        fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, crate::core_error::CoreError> {
            self.calls.lock().unwrap().push(request.method.clone());
            if request.method == "printer.info" {
                return Ok(serde_json::json!({"state":self.state,"state_message":"Heater extruder not heating at expected rate"}));
            }
            Err(crate::core_error::CoreError::from_legacy("Moonraker RPC error: Klippy is shutdown"))
        }
        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot { Default::default() }
    }

    #[test]
    fn klippy_shutdown_reads_info_when_object_queries_are_unavailable() {
        let transport = Arc::new(KlippyInfoTestTransport { state:"shutdown", calls:Mutex::new(Vec::new()) });
        let (mut actor, journal, path) = fault_test_actor(transport.clone());
        actor.snapshot.nozzle_updated_at = Some(1);
        actor.snapshot.bed_updated_at = Some(2);
        actor.reconcile_if_due();
        assert_eq!(actor.snapshot.cached_status.pointer("/webhooks/state"), Some(&serde_json::json!("shutdown")));
        assert_eq!(actor.snapshot.phase, PrinterPhase::Degraded);
        assert!(actor.snapshot.connected);
        assert_eq!(actor.snapshot.connection_presentation(now_ms()).message, "Heater extruder not heating at expected rate");
        assert_eq!(actor.snapshot.nozzle_updated_at, Some(1), "printer.info cannot freshen cached heater readings");
        assert_eq!(actor.snapshot.bed_updated_at, Some(2));
        assert_eq!(*transport.calls.lock().unwrap(), vec!["printer.objects.query", "printer.objects.query", "printer.info"]);
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn klippy_ready_is_recovered_without_ready_notification() {
        let transport = Arc::new(KlippyInfoTestTransport { state:"ready", calls:Mutex::new(Vec::new()) });
        let (mut actor, journal, path) = fault_test_actor(transport);
        actor.apply_status(serde_json::json!({"webhooks":{"state":"shutdown","state_message":"Heater failure"}}), Some(900.0), "websocket");
        actor.refresh_klippy_info();
        assert!(actor.subscription_pending);
        assert!(actor.snapshot.last_eventtime.is_none());
        assert_eq!(actor.snapshot.phase, PrinterPhase::Ready);
        assert_eq!(actor.snapshot.cached_status.pointer("/webhooks/state"), Some(&serde_json::json!("ready")));
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn klippy_restart_resubscribes_on_the_same_real_websocket() {
        use std::io::{Read, Write};
        fn read_frame(stream: &mut std::net::TcpStream) -> (u8, Value) {
            let mut head = [0_u8; 2]; stream.read_exact(&mut head).unwrap();
            assert_ne!(head[1] & 0x80, 0);
            let mut length = (head[1] & 0x7f) as usize;
            if length == 126 { let mut size=[0_u8;2];stream.read_exact(&mut size).unwrap();length=u16::from_be_bytes(size) as usize; }
            assert!(length < 16_384);
            let mut mask=[0_u8;4];stream.read_exact(&mut mask).unwrap();
            let mut body=vec![0_u8;length];stream.read_exact(&mut body).unwrap();
            for (index, byte) in body.iter_mut().enumerate() { *byte ^= mask[index % 4]; }
            (head[0] & 0xf, if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap() })
        }
        fn send(stream: &mut std::net::TcpStream, value: Value) {
            let body=serde_json::to_vec(&value).unwrap();let mut frame=vec![0x81];
            if body.len()<126 { frame.push(body.len() as u8); } else { frame.push(126);frame.extend_from_slice(&(body.len() as u16).to_be_bytes()); }
            frame.extend(body);stream.write_all(&frame).unwrap();
        }
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let subscriptions=Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed=Arc::clone(&subscriptions);
        // Причина shutdown обязана дойти до оператора из printer.info, а не остаться
        // подстановкой «Klipper перешёл в shutdown».
        let shutdown_reason=Arc::new(std::sync::Mutex::new(String::new()));
        let observed_reason=Arc::clone(&shutdown_reason);
        let server=std::thread::spawn(move || {
            let (mut stream,_)=listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut header=Vec::new();let mut byte=[0_u8;1];
            while !header.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap();header.push(byte[0]);assert!(header.len()<16_384); }
            let header=String::from_utf8(header).unwrap();
            let key=header.lines().find_map(|line|line.split_once(':').filter(|(name,_)|name.eq_ignore_ascii_case("Sec-WebSocket-Key")).map(|(_,value)|value.trim())).unwrap();
            write!(stream,"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",crate::websocket_accept_key(key)).unwrap();
            let (_,identify)=read_frame(&mut stream);assert_eq!(identify["method"],"server.connection.identify");
            send(&mut stream,serde_json::json!({"jsonrpc":"2.0","id":identify["id"],"result":"ok"}));
            for generation in 0..2 {
                let (_,list)=read_frame(&mut stream);assert_eq!(list["method"],"printer.objects.list");
                send(&mut stream,serde_json::json!({"jsonrpc":"2.0","id":list["id"],"result":{"objects":["print_stats","extruder","heater_bed","webhooks"]}}));
                let (_,subscribe)=read_frame(&mut stream);assert_eq!(subscribe["method"],"printer.objects.subscribe");
                observed.fetch_add(1,Ordering::SeqCst);
                send(&mut stream,serde_json::json!({"jsonrpc":"2.0","id":subscribe["id"],"result":{"eventtime":if generation==0 {900.0}else{1.0},"status":{"webhooks":{"state":"ready","state_message":"Printer is ready"},"print_stats":{"state":"standby"},"extruder":{"temperature":25.0},"heater_bed":{"temperature":24.0}}}}));
                if generation==0 {
                    send(&mut stream,serde_json::json!({"method":"notify_klippy_shutdown"}));
                    send(&mut stream,serde_json::json!({"method":"notify_klippy_disconnected"}));
                    send(&mut stream,serde_json::json!({"method":"notify_klippy_ready"}));
                    let (_,info)=read_frame(&mut stream);
                    assert_eq!(info["method"],"printer.info","shutdown must ask Klipper for the real reason");
                    let reason="MCU 'mcu' shutdown: Timer too close";
                    *observed_reason.lock().unwrap()=reason.to_string();
                    send(&mut stream,serde_json::json!({"jsonrpc":"2.0","id":info["id"],"result":{"state":"shutdown","state_message":reason}}));
                }
            }
            send(&mut stream,serde_json::json!({"method":"notify_status_update","params":[{"extruder":{"temperature":28.0}},1.1]}));
            assert_eq!(read_frame(&mut stream).0,8,"the client sent an unexpected printer command");
        });
        let (mut actor,journal,path)=fault_test_actor(Arc::new(NoopTransport));
        actor.config.host=address.to_string();actor.config.default_port=address.port();actor.snapshot.active_port=address.port();
        actor.websocket=Some(PersistentWebSocket::connect(&actor.config,address.port(),actor.runtime.clone()).unwrap());
        actor.initialize_subscription().unwrap();
        let deadline=Instant::now()+Duration::from_secs(4);
        while actor.snapshot.cached_status.pointer("/webhooks/state").and_then(Value::as_str)!=Some("ready") || !actor.subscription_pending || actor.snapshot.last_eventtime.is_some() {
            assert!(Instant::now()<deadline,"Klipper lifecycle notifications were not received");actor.poll_websocket().unwrap();
        }
        actor.reconcile_if_due();
        assert!(!actor.subscription_pending,"the fresh subscription must be installed automatically");
        assert_eq!(subscriptions.load(Ordering::SeqCst),2,"there must be exactly one subscription per controller generation");
        while actor.snapshot.cached_status.pointer("/extruder/temperature").and_then(Value::as_f64)!=Some(28.0) {
            assert!(Instant::now()<deadline,"new-generation live temperatures were discarded");actor.poll_websocket().unwrap();
        }
        assert_eq!(actor.snapshot.last_eventtime,Some(1.1));
        assert_eq!(actor.snapshot.phase,PrinterPhase::Ready);
        actor.finish();server.join().unwrap();
        drop(actor);drop(journal);let _=std::fs::remove_file(path);
    }

    #[test]
    fn acknowledged_start_recovers_observation_over_rest_after_ws_failure() {
        let transport = Arc::new(StartPathRecordingTransport { calls:Mutex::new(Vec::new()), printing:true });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        let admissions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        actor.websocket = Some(PersistentWebSocket::rpc_failure_for_test(Some("Moonraker closed the WebSocket connection"), admissions.clone()));
        let mut operation = request("printer.print.start", Some(serde_json::json!({"filename":"part.gcode"})));
        operation.deadline_at_ms = now_ms() + 5_000;
        journal.create("start-path", 0, &operation, now_ms()).unwrap();
        journal.transition("op", OperationState::Sent, now_ms(), None, None, true).unwrap();
        let began = Instant::now();
        let result = actor.verify_print_start(&operation, serde_json::json!("ok"), &Arc::new(AtomicBool::new(false)));
        assert!(result.is_ok(), "{result:?}");
        assert!(began.elapsed() < Duration::from_secs(5));
        assert_eq!(admissions.load(Ordering::SeqCst), 1);
        assert_eq!(*transport.calls.lock().unwrap(), vec![("printer.objects.query".into(), true)],
            "an acknowledged start may recover only its read-only observation");
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn preadmission_disconnected_ws_dispatches_exactly_one_rest_start() {
        let transport = Arc::new(StartPathRecordingTransport { calls:Mutex::new(Vec::new()), printing:true });
        let (mut actor, journal, path) = start_path_actor(transport.clone());
        let admissions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        actor.websocket = Some(PersistentWebSocket::rpc_failure_for_test(None, admissions.clone()));
        let operation = request("printer.print.start", Some(serde_json::json!({"filename":"part.gcode"})));
        journal.create("start-path", 0, &operation, now_ms()).unwrap();
        let result = actor.execute_operation(&operation, &Arc::new(AtomicBool::new(false)));
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(admissions.load(Ordering::SeqCst), 0, "the failed WS request must never have entered its writer queue");
        assert_eq!(*transport.calls.lock().unwrap(), vec![("printer.print.start".into(), true), ("printer.objects.query".into(), true)]);
        drop(actor); drop(journal); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn admitted_or_ambiguous_ws_start_is_never_dispatched_again_over_rest() {
        for error in ["WebSocket response timeout", "Moonraker closed the WebSocket connection", "ASYNC_WEBSOCKET_DISCONNECTED after admission"] {
            let transport = Arc::new(StartPathRecordingTransport { calls:Mutex::new(Vec::new()), printing:false });
            let (mut actor, journal, path) = start_path_actor(transport.clone());
            let admissions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            actor.websocket = Some(PersistentWebSocket::rpc_failure_for_test(Some(error), admissions.clone()));
            let operation = request("printer.print.start", Some(serde_json::json!({"filename":"part.gcode"})));
            journal.create("start-path", 0, &operation, now_ms()).unwrap();
            assert!(actor.execute_operation(&operation, &Arc::new(AtomicBool::new(false))).is_err());
            assert_eq!(admissions.load(Ordering::SeqCst), 1);
            assert!(transport.calls.lock().unwrap().iter().all(|(method, _)| method != "printer.print.start"), "{error}: start was replayed");
            drop(actor); drop(journal); let _ = std::fs::remove_file(path);
        }
    }

    struct CameraPauseTransport {
        status: Value,
        query_fails: bool,
        pause_fails: bool,
        calls: Mutex<Vec<(String, Option<Value>)>>,
    }

    impl MoonrakerTransport for CameraPauseTransport {
        fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, crate::core_error::CoreError> {
            self.calls.lock().unwrap().push((request.method.clone(), request.params));
            match request.method.as_str() {
                "printer.objects.query" if self.query_fails => Err(crate::core_error::CoreError::from_legacy("test timeout")),
                "printer.objects.query" => Ok(serde_json::json!({"status":self.status})),
                "printer.print.pause" if self.pause_fails => Err(crate::core_error::CoreError::from_legacy("test timeout")),
                "printer.print.pause" => Ok(serde_json::json!("ok")),
                _ => panic!("unexpected camera guard RPC: {}", request.method),
            }
        }
        fn snapshot(&self) -> super::super::moonraker_transport::TransportSnapshot { Default::default() }
    }

    fn camera_pause_params(at: i64) -> Value {
        serde_json::json!({"_cameraGuard":{"filename":"part.gcode","minimumPrintDuration":100.0,"requestedAtMs":at,"maxAgeMs":10_000}})
    }

    fn camera_pause_fixture(params: Option<Value>, status: Value, query_fails: bool, pause_fails: bool)
        -> (Result<OperationResult, String>, Vec<(String, Option<Value>)>)
    {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("kf-camera-pause-{nonce}.sqlite3"));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id:"camera-test".into(),printer_id:"camera-test".into(),model_id:Some("custom".into()),
            host:"127.0.0.1:7125".into(),default_port:7125,api_key:None,firmware_signature:None,capabilities_hint:None,
        };
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let shared = Arc::new(Mutex::new(ActorSnapshot::new(&config)));
        let transport = Arc::new(CameraPauseTransport {status,query_fails,pause_fails,calls:Mutex::new(Vec::new())});
        let mut actor = PrinterActor::new(ActorEventSink::headless(),config,sender,receiver,shared,
            Arc::new(Mutex::new(HashMap::new())),journal.clone(),Arc::new(FarmScheduler::default()),
            EngineRuntime::new().unwrap(),transport.clone());
        // An old matching cache must never substitute for the fresh query.
        actor.snapshot.cached_status = serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":101.0}});
        let operation = request("printer.print.pause",params);
        journal.create("camera-test",0,&operation,now_ms()).unwrap();
        let result = actor.execute_operation(&operation,&Arc::new(AtomicBool::new(false)));
        let calls = transport.calls.lock().unwrap().clone();
        drop(actor);drop(journal);let _ = std::fs::remove_file(&path);
        (result,calls)
    }

    #[test]
    fn camera_guard_pause_queries_live_job_and_strips_local_metadata() {
        let (result,calls) = camera_pause_fixture(Some(camera_pause_params(now_ms())),
            serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":101.0}}),false,false);
        assert!(result.is_ok(),"{result:?}");
        assert_eq!(calls.len(),2);
        assert_eq!(calls[0].0,"printer.objects.query");
        assert_eq!(calls[1],("printer.print.pause".to_string(),None));
    }

    #[test]
    fn camera_guard_refuses_other_restarted_stale_or_unavailable_jobs_without_pause() {
        for (status,expired,query_fails) in [
            (serde_json::json!({"print_stats":{"state":"printing","filename":"other.gcode","print_duration":101.0}}),false,false),
            (serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":10.0}}),false,false),
            (serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":500.0}}),false,false),
            (serde_json::json!({"print_stats":{"state":"paused","filename":"part.gcode","print_duration":101.0}}),false,false),
            (serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":101.0}}),true,false),
            (serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":101.0}}),false,true),
        ] {
            let (result,calls) = camera_pause_fixture(Some(camera_pause_params(now_ms()-if expired {10_001} else {0})),status,query_fails,false);
            assert!(result.as_ref().is_err_and(|error| error.starts_with("CAMERA_GUARD_BLOCKED:")),"{result:?}");
            assert!(!calls.iter().any(|call| call.0=="printer.print.pause"),"{calls:?}");
            if expired {assert!(calls.is_empty());}
        }
    }

    #[test]
    fn camera_guard_does_not_replay_an_ambiguous_pause_and_manual_pause_is_unchanged() {
        let status=serde_json::json!({"print_stats":{"state":"printing","filename":"part.gcode","print_duration":101.0}});
        let (result,calls)=camera_pause_fixture(Some(camera_pause_params(now_ms())),status.clone(),false,true);
        assert!(result.as_ref().is_err_and(|error| error.starts_with("RESULT_UNKNOWN")),"{result:?}");
        assert_eq!(calls.iter().filter(|call|call.0=="printer.print.pause").count(),1,"{calls:?}");
        let (result,calls)=camera_pause_fixture(None,status,false,false);
        assert!(result.is_ok(),"{result:?}");
        assert_eq!(calls,vec![("printer.print.pause".to_string(),None)]);
    }

    #[test]
    fn camera_guard_schema_and_age_are_bounded_and_never_apply_to_manual_pause() {
        let now=now_ms();
        assert!(camera_pause_guard(&request("printer.print.pause",None),now).unwrap().is_none());
        assert!(camera_pause_guard(&request("printer.print.pause",Some(serde_json::json!({}))),now).unwrap().is_none());
        for params in [
            serde_json::json!({"_cameraGuard":null}),
            serde_json::json!({"_cameraGuard":{},"other":true}),
            camera_pause_params(now-10_001),camera_pause_params(now+2_001),
            serde_json::json!({"_cameraGuard":{"filename":"part.gcode","minimumPrintDuration":100.0,"requestedAtMs":now,"maxAgeMs":60_000}}),
        ] { assert!(camera_pause_guard(&request("printer.print.pause",Some(params)),now).is_err()); }
    }

    #[test]
    fn arbitrary_gcode_is_never_inferred() {
        let operation = request(
            "printer.gcode.script",
            Some(serde_json::json!({"script":"G28"})),
        );
        assert!(!operation_observed(&operation, &serde_json::json!({})));
    }

    #[test]
    fn print_start_is_not_retried_from_idle_state() {
        let operation = request(
            "printer.print.start",
            Some(serde_json::json!({"filename":"part.gcode"})),
        );
        let idle = serde_json::json!({"print_stats":{"state":"standby","filename":"part.gcode"}});
        assert!(!retry_is_safe(&operation, &idle));
    }

    #[test]
    fn status_merge_preserves_unchanged_fields() {
        let mut status = serde_json::json!({"extruder":{"temperature":20,"target":0}});
        merge_json(
            &mut status,
            serde_json::json!({"extruder":{"temperature":21}}),
        );
        assert_eq!(
            status.pointer("/extruder/temperature"),
            Some(&serde_json::json!(21))
        );
        assert_eq!(
            status.pointer("/extruder/target"),
            Some(&serde_json::json!(0))
        );
    }

    #[test]
    fn actor_reconfigure_ack_is_nonblocking_while_worker_is_busy() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "klipper-farm-reconfigure-{}-{nonce}.sqlite3",
            std::process::id()
        ));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id: "stable-nonblocking".into(),
            printer_id: "printer-nonblocking".into(),
            model_id: Some("custom".into()),
            host: "127.0.0.1:7125".into(),
            default_port: 7125,
            api_key: None,
            firmware_signature: None,
            capabilities_hint: None,
        };
        let (sender, _receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let snapshot = Arc::new(Mutex::new(ActorSnapshot::new(&config)));
        let scheduler = Arc::new(FarmScheduler::default());
        let transport: Arc<dyn MoonrakerTransport> = Arc::new(NoopTransport);
        let handle = ActorHandle {
            sender,
            snapshot: Arc::clone(&snapshot),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            emergency: EmergencyTransport {
                event_sink: ActorEventSink::headless(),
                config: Arc::new(Mutex::new(config.clone())),
                snapshot,
                journal: journal.clone(),
                scheduler,
                transport,
            },
            alive: Arc::new(AtomicBool::new(true)),
        };
        let started = Instant::now();
        let returned = handle.reconfigure(config).unwrap();
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(returned.printer_id, "printer-nonblocking");

        drop(handle);
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn headless_status_is_recoverable_from_shared_snapshot_without_live_event_sink() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "klipper-farm-headless-snapshot-{}-{nonce}.sqlite3",
            std::process::id()
        ));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);

        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id: "stable-headless".into(),
            printer_id: "printer-headless".into(),
            model_id: Some("custom".into()),
            host: "127.0.0.1:7125".into(),
            default_port: 7125,
            api_key: None,
            firmware_signature: None,
            capabilities_hint: None,
        };
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        let shared = Arc::new(Mutex::new(ActorSnapshot::new(&config)));
        let mut actor = PrinterActor::new(
            ActorEventSink::headless(),
            config,
            sender,
            receiver,
            Arc::clone(&shared),
            Arc::new(Mutex::new(HashMap::new())),
            journal.clone(),
            Arc::new(FarmScheduler::default()),
            EngineRuntime::new().unwrap(),
            Arc::new(NoopTransport),
        );

        for method in ["printer.objects.query", "server.info"] {
            let (reply, _) = mpsc::channel();
            actor.queue.push(QueuedOperation { sequence: 1, request: request(method, None), cancelled: Arc::new(AtomicBool::new(false)), reply });
        }
        actor.update_queue_size();
        assert_eq!(shared.lock().unwrap().queued_operations, 2);
        assert_eq!(shared.lock().unwrap().update_blocking_operations, Some(0));
        let (reply, _) = mpsc::channel();
        actor.queue.push(QueuedOperation { sequence: 2, request: request("unknown.mutation", None), cancelled: Arc::new(AtomicBool::new(false)), reply });
        actor.update_queue_size();
        assert_eq!(shared.lock().unwrap().update_blocking_operations, Some(1));
        actor.active_update_operation = true;
        actor.sync_shared_snapshot();
        assert_eq!(shared.lock().unwrap().update_blocking_operations, Some(2));
        actor.active_update_operation = false;
        actor.queue.clear();
        actor.update_queue_size();

        actor.apply_status(
            serde_json::json!({
                "print_stats":{"state":"standby"},
                "extruder":{"temperature":24.2,"target":0},
                "heater_bed":{"temperature":23.8,"target":0},
                "webhooks":{"state":"ready"}
            }),
            Some(42.0),
            "websocket",
        );
        let snapshot = shared.lock().unwrap().clone();
        assert!(snapshot.connected);
        assert_eq!(snapshot.last_eventtime, Some(42.0));
        assert!(snapshot.telemetry_updated_at.is_some());
        assert!(snapshot.job_updated_at.is_some());
        assert_eq!(
            snapshot.cached_status.pointer("/extruder/temperature"),
            Some(&serde_json::json!(24.2))
        );

        // Full reconciliations from vendor forks may repeat an eventtime. The
        // snapshot must still refresh and merge, while an out-of-order
        // WebSocket delta with the same/lower eventtime stays rejected.
        actor.apply_status(
            serde_json::json!({
                "print_stats":{"state":"printing","filename":"live.gcode"},
                "virtual_sdcard":{"progress":0.42}
            }),
            Some(42.0),
            "rest_reconcile",
        );
        assert_eq!(
            actor.snapshot.cached_status.pointer("/print_stats/state"),
            Some(&serde_json::json!("printing"))
        );
        actor.apply_status(
            serde_json::json!({"print_stats":{"state":"error"}}),
            Some(41.0),
            "websocket",
        );
        assert_eq!(
            actor.snapshot.cached_status.pointer("/print_stats/state"),
            Some(&serde_json::json!("printing"))
        );
        assert!(journal
            .pending_events("printer-headless", 10)
            .unwrap()
            .is_empty());

        actor.publish_snapshot("connected", None, None);
        let lifecycle = journal.pending_events("printer-headless", 10).unwrap();
        assert_eq!(lifecycle.len(), 1);
        assert_eq!(lifecycle[0].kind, "connected");

        drop(actor);
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    #[ignore = "requires scripts/hardware-emulator.mjs on KF_TEST_MOONRAKER_HOST"]
    fn headless_actor_physically_receives_websocket_telemetry() {
        let host = std::env::var("KF_TEST_MOONRAKER_HOST")
            .expect("KF_TEST_MOONRAKER_HOST must point to the hardware emulator");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "klipper-farm-headless-physical-{}-{nonce}.sqlite3",
            std::process::id()
        ));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id: "runtime-external-emulator".into(),
            printer_id: "printer-external-emulator".into(),
            model_id: Some("creality-k1c-2025".into()),
            host,
            default_port: 7125,
            api_key: None,
            firmware_signature: None,
            capabilities_hint: None,
        };
        let actor = ActorHandle::spawn(
            ActorEventSink::headless(),
            config,
            journal.clone(),
            Arc::new(FarmScheduler::default()),
            EngineRuntime::new().unwrap(),
            Arc::new(super::super::moonraker_transport::NativeMoonrakerTransport::default()),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(35);
        let snapshot = loop {
            let snapshot = actor.snapshot();
            if snapshot.connected
                && snapshot
                    .cached_status
                    .pointer("/extruder/temperature")
                    .is_some()
            {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "headless actor did not receive emulator telemetry: {:?}",
                snapshot.last_error
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(snapshot.active_protocol, "websocket");
        assert_eq!(
            snapshot.cached_status.pointer("/webhooks/state"),
            Some(&serde_json::json!("ready"))
        );
        assert!(snapshot.last_seen_at.is_some());
        assert!(journal
            .pending_events("printer-external-emulator", 64)
            .unwrap()
            .iter()
            .any(|event| event.kind == "connected"));

        actor.shutdown();
        drop(actor);
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    #[ignore = "requires REST-only scripts/hardware-emulator.mjs on KF_TEST_MOONRAKER_HOST"]
    fn disconnected_headless_actor_physically_uses_rest_compatibility_rpc() {
        let host = std::env::var("KF_TEST_MOONRAKER_HOST")
            .expect("KF_TEST_MOONRAKER_HOST must point to the REST-only emulator");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "klipper-farm-rest-physical-{}-{nonce}.sqlite3",
            std::process::id()
        ));
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);
        let journal = Journal::new(&path).unwrap();
        let config = ActorConfig {
            stable_id: "runtime-rest-emulator".into(),
            printer_id: "printer-rest-emulator".into(),
            model_id: Some("flashforge-ad5m".into()),
            host,
            default_port: 7125,
            api_key: None,
            firmware_signature: None,
            capabilities_hint: None,
        };
        let actor = ActorHandle::spawn(
            ActorEventSink::headless(),
            config,
            journal.clone(),
            Arc::new(FarmScheduler::default()),
            EngineRuntime::new().unwrap(),
            Arc::new(super::super::moonraker_transport::NativeMoonrakerTransport::default()),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let snapshot = actor.snapshot();
            if !snapshot.connected && snapshot.reconnect_attempt > 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "REST-only actor did not reject WebSocket"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let result = actor
            .execute(OperationRequest {
                operation_id: "33333333333333333333333333333333".into(),
                method: "printer.objects.query".into(),
                params: Some(serde_json::json!({"objects":{
                    "print_stats":null,"extruder":null,"heater_bed":null
                }})),
                priority: OperationPriority::Telemetry,
                repeat_policy: RepeatPolicy::Safe,
                prefer_rest: true,
                timeout_ms: 4_000,
                deadline_at_ms: now_ms().saturating_add(10_000),
                expected_session_epoch: None,
            })
            .unwrap();
        let temperature = result
            .result
            .pointer("/status/extruder/temperature")
            .or_else(|| result.result.pointer("/result/status/extruder/temperature"));
        assert_eq!(temperature, Some(&serde_json::json!(24.2)));
        let reachable = actor.snapshot();
        assert!(reachable.connected);
        assert_eq!(reachable.active_protocol, "disconnected");

        actor.shutdown();
        drop(actor);
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }
}
