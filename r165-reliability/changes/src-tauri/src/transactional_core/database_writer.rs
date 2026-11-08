use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const CRITICAL_QUEUE_CAPACITY: usize = 256;
const NORMAL_QUEUE_CAPACITY: usize = 512;
const TELEMETRY_QUEUE_CAPACITY: usize = 1_024;
const CRITICAL_BURST: usize = 16;
const MAX_TELEMETRY_BATCH: usize = 128;
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(5);
const CRITICAL_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const NORMAL_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(60);
const CHECKPOINT_WRITES: u64 = 1_000;

type DatabaseJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Debug, Clone)]
pub(crate) struct ActorStateWrite {
    pub stable_id: String,
    pub printer_id: String,
    pub model_id: Option<String>,
    pub host: String,
    pub active_port: u16,
    pub session_epoch: u64,
    pub phase: String,
    pub firmware_signature: Option<String>,
    pub capabilities_json: String,
    pub cached_status_json: String,
    pub last_eventtime: Option<f64>,
    pub last_seen_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseWriterSnapshot {
    pub critical_writes: u64,
    pub normal_writes: u64,
    pub telemetry_writes: u64,
    pub telemetry_batches: u64,
    pub telemetry_submitted: u64,
    pub telemetry_completed: u64,
    pub dropped_telemetry: u64,
    pub backpressure_events: u64,
    pub checkpoint_count: u64,
    pub integrity_checks: u64,
    pub integrity_failures: u64,
    pub critical_queue_depth: usize,
    pub normal_queue_depth: usize,
    pub telemetry_queue_depth: usize,
    pub max_critical_queue_depth: usize,
    pub max_normal_queue_depth: usize,
    pub max_telemetry_queue_depth: usize,
}

#[derive(Debug, Default)]
struct WriterMetrics {
    critical_writes: AtomicU64,
    normal_writes: AtomicU64,
    telemetry_writes: AtomicU64,
    telemetry_batches: AtomicU64,
    telemetry_submitted: AtomicU64,
    telemetry_completed: AtomicU64,
    dropped_telemetry: AtomicU64,
    backpressure_events: AtomicU64,
    checkpoint_count: AtomicU64,
    integrity_checks: AtomicU64,
    integrity_failures: AtomicU64,
    critical_queue_depth: AtomicUsize,
    normal_queue_depth: AtomicUsize,
    telemetry_queue_depth: AtomicUsize,
    max_critical_queue_depth: AtomicUsize,
    max_normal_queue_depth: AtomicUsize,
    max_telemetry_queue_depth: AtomicUsize,
}

struct DatabaseWriterInner {
    critical_sender: SyncSender<DatabaseJob>,
    normal_sender: SyncSender<DatabaseJob>,
    telemetry_sender: SyncSender<ActorStateWrite>,
    wake_sender: SyncSender<()>,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
    metrics: Arc<WriterMetrics>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for DatabaseWriterInner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake_sender.try_send(());
        if let Ok(mut slot) = self.join.lock() {
            if let Some(handle) = slot.take() {
                let _ = handle.join();
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct DatabaseWriter {
    inner: Arc<DatabaseWriterInner>,
}

impl std::fmt::Debug for DatabaseWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DatabaseWriter")
            .field("alive", &self.inner.alive.load(Ordering::Acquire))
            .field("metrics", &self.snapshot())
            .finish()
    }
}

impl DatabaseWriter {
    pub fn new(database_path: impl AsRef<Path>) -> Result<Self, String> {
        let mut connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA busy_timeout=5000;
                 PRAGMA wal_autocheckpoint=0;
                 -- Освобождать освободившиеся страницы по ходу работы, а не копить их:
                 -- на живой ферме база выросла до 844 МБ, из них 38 МБ мёртвого места
                 -- (freelist), потому что auto_vacuum был выключен, а VACUUM не вызывался.
                 PRAGMA auto_vacuum=INCREMENTAL;",
            )
            .map_err(|error| error.to_string())?;
        let metrics = Arc::new(WriterMetrics::default());
        verify_integrity(&connection, &metrics)?;

        let (critical_sender, critical_receiver) = mpsc::sync_channel(CRITICAL_QUEUE_CAPACITY);
        let (normal_sender, normal_receiver) = mpsc::sync_channel(NORMAL_QUEUE_CAPACITY);
        let (telemetry_sender, telemetry_receiver) = mpsc::sync_channel(TELEMETRY_QUEUE_CAPACITY);
        let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let last_error = Arc::new(Mutex::new(None));
        let worker_stop = Arc::clone(&stop);
        let worker_alive = Arc::clone(&alive);
        let worker_error = Arc::clone(&last_error);
        let worker_metrics = Arc::clone(&metrics);
        let join = thread::Builder::new()
            .name("klipper-farm-database-writer-v2".into())
            .spawn(move || {
                writer_loop(
                    &mut connection,
                    critical_receiver,
                    normal_receiver,
                    telemetry_receiver,
                    wake_receiver,
                    &worker_stop,
                    &worker_error,
                    &worker_metrics,
                );
                worker_alive.store(false, Ordering::Release);
            })
            .map_err(|error| format!("Не удалось запустить DatabaseWriter v2: {error}"))?;
        Ok(Self {
            inner: Arc::new(DatabaseWriterInner {
                critical_sender,
                normal_sender,
                telemetry_sender,
                wake_sender,
                stop,
                alive,
                last_error,
                metrics,
                join: Mutex::new(Some(join)),
            }),
        })
    }

    pub fn critical<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    {
        self.ensure_available()?;
        let (reply, response) = mpsc::sync_channel(1);
        let job = Box::new(move |connection: &mut Connection| {
            let _ = reply.send(operation(connection));
        });
        self.submit_critical(job)?;
        response.recv_timeout(CRITICAL_ACK_TIMEOUT).map_err(|_| {
            "DATABASE_WRITER_TIMEOUT: критическая запись не подтверждена".to_string()
        })?
    }

    pub fn normal<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    {
        self.ensure_available()?;
        let (reply, response) = mpsc::sync_channel(1);
        let job = Box::new(move |connection: &mut Connection| {
            let _ = reply.send(operation(connection));
        });
        let depth = &self.inner.metrics.normal_queue_depth;
        let max_depth = &self.inner.metrics.max_normal_queue_depth;
        depth.fetch_add(1, Ordering::AcqRel);
        match self.inner.normal_sender.try_send(job) {
            Ok(()) => {
                update_max(max_depth, depth.load(Ordering::Acquire));
                self.wake();
                response.recv_timeout(NORMAL_ACK_TIMEOUT).map_err(|_| {
                    "DATABASE_WRITER_TIMEOUT: normal-запись не подтверждена".to_string()
                })?
            }
            Err(TrySendError::Full(_)) => {
                depth.fetch_sub(1, Ordering::AcqRel);
                self.inner
                    .metrics
                    .backpressure_events
                    .fetch_add(1, Ordering::Relaxed);
                Err("DATABASE_WRITER_BUSY: normal-очередь переполнена".into())
            }
            Err(TrySendError::Disconnected(_)) => {
                depth.fetch_sub(1, Ordering::AcqRel);
                Err("DATABASE_WRITER_STOPPED: normal-канал закрыт".into())
            }
        }
    }

    pub fn actor_snapshot(&self, snapshot: ActorStateWrite) -> Result<(), String> {
        self.ensure_available()?;
        if let Some(error) = self
            .inner
            .last_error
            .lock()
            .map_err(|_| "DatabaseWriter error state недоступен")?
            .take()
        {
            return Err(format!("DATABASE_WRITER_ASYNC_ERROR: {error}"));
        }
        let depth = &self.inner.metrics.telemetry_queue_depth;
        let max_depth = &self.inner.metrics.max_telemetry_queue_depth;
        depth.fetch_add(1, Ordering::AcqRel);
        match self.inner.telemetry_sender.try_send(snapshot) {
            Ok(()) => {
                self.inner
                    .metrics
                    .telemetry_submitted
                    .fetch_add(1, Ordering::AcqRel);
                update_max(max_depth, depth.load(Ordering::Acquire));
                self.wake();
                Ok(())
            }
            Err(TrySendError::Full(_)) => {
                depth.fetch_sub(1, Ordering::AcqRel);
                self.inner
                    .metrics
                    .dropped_telemetry
                    .fetch_add(1, Ordering::Relaxed);
                self.inner
                    .metrics
                    .backpressure_events
                    .fetch_add(1, Ordering::Relaxed);
                Err("DATABASE_WRITER_BUSY: telemetry snapshot будет повторён".into())
            }
            Err(TrySendError::Disconnected(_)) => {
                depth.fetch_sub(1, Ordering::AcqRel);
                Err("DATABASE_WRITER_STOPPED: telemetry-канал закрыт".into())
            }
        }
    }

    /// Waits until every telemetry snapshot accepted before this call has
    /// either committed or produced a durable writer error. This is a fence,
    /// not a global pause: snapshots accepted concurrently after the captured
    /// sequence remain asynchronous.
    pub fn flush_telemetry(&self) -> Result<(), String> {
        self.ensure_available()?;
        let target = self
            .inner
            .metrics
            .telemetry_submitted
            .load(Ordering::Acquire);
        let deadline = Instant::now() + NORMAL_ACK_TIMEOUT;
        loop {
            if self
                .inner
                .metrics
                .telemetry_completed
                .load(Ordering::Acquire)
                >= target
            {
                if let Some(error) = self
                    .inner
                    .last_error
                    .lock()
                    .map_err(|_| "DatabaseWriter error state недоступен")?
                    .take()
                {
                    return Err(format!("DATABASE_WRITER_ASYNC_ERROR: {error}"));
                }
                return Ok(());
            }
            self.ensure_available()?;
            if Instant::now() >= deadline {
                return Err("DATABASE_WRITER_TIMEOUT: telemetry flush не подтверждён".into());
            }
            self.wake();
            thread::sleep(Duration::from_millis(1));
        }
    }

    pub fn snapshot(&self) -> DatabaseWriterSnapshot {
        let metrics = &self.inner.metrics;
        DatabaseWriterSnapshot {
            critical_writes: metrics.critical_writes.load(Ordering::Relaxed),
            normal_writes: metrics.normal_writes.load(Ordering::Relaxed),
            telemetry_writes: metrics.telemetry_writes.load(Ordering::Relaxed),
            telemetry_batches: metrics.telemetry_batches.load(Ordering::Relaxed),
            telemetry_submitted: metrics.telemetry_submitted.load(Ordering::Relaxed),
            telemetry_completed: metrics.telemetry_completed.load(Ordering::Relaxed),
            dropped_telemetry: metrics.dropped_telemetry.load(Ordering::Relaxed),
            backpressure_events: metrics.backpressure_events.load(Ordering::Relaxed),
            checkpoint_count: metrics.checkpoint_count.load(Ordering::Relaxed),
            integrity_checks: metrics.integrity_checks.load(Ordering::Relaxed),
            integrity_failures: metrics.integrity_failures.load(Ordering::Relaxed),
            critical_queue_depth: metrics.critical_queue_depth.load(Ordering::Relaxed),
            normal_queue_depth: metrics.normal_queue_depth.load(Ordering::Relaxed),
            telemetry_queue_depth: metrics.telemetry_queue_depth.load(Ordering::Relaxed),
            max_critical_queue_depth: metrics.max_critical_queue_depth.load(Ordering::Relaxed),
            max_normal_queue_depth: metrics.max_normal_queue_depth.load(Ordering::Relaxed),
            max_telemetry_queue_depth: metrics.max_telemetry_queue_depth.load(Ordering::Relaxed),
        }
    }

    fn ensure_available(&self) -> Result<(), String> {
        if !self.inner.alive.load(Ordering::Acquire) {
            return Err("DATABASE_WRITER_STOPPED: поток записи завершён".into());
        }
        Ok(())
    }

    fn submit_critical(&self, mut job: DatabaseJob) -> Result<(), String> {
        let deadline = Instant::now() + SUBMIT_TIMEOUT;
        loop {
            self.inner
                .metrics
                .critical_queue_depth
                .fetch_add(1, Ordering::AcqRel);
            match self.inner.critical_sender.try_send(job) {
                Ok(()) => {
                    update_max(
                        &self.inner.metrics.max_critical_queue_depth,
                        self.inner
                            .metrics
                            .critical_queue_depth
                            .load(Ordering::Acquire),
                    );
                    self.wake();
                    return Ok(());
                }
                Err(TrySendError::Full(returned)) => {
                    self.inner
                        .metrics
                        .critical_queue_depth
                        .fetch_sub(1, Ordering::AcqRel);
                    self.inner
                        .metrics
                        .backpressure_events
                        .fetch_add(1, Ordering::Relaxed);
                    if Instant::now() >= deadline {
                        return Err("DATABASE_WRITER_BUSY: critical-очередь переполнена".into());
                    }
                    job = returned;
                    thread::sleep(Duration::from_millis(2));
                }
                Err(TrySendError::Disconnected(_)) => {
                    self.inner
                        .metrics
                        .critical_queue_depth
                        .fetch_sub(1, Ordering::AcqRel);
                    return Err("DATABASE_WRITER_STOPPED: critical-канал закрыт".into());
                }
            }
        }
    }

    fn wake(&self) {
        let _ = self.inner.wake_sender.try_send(());
    }
}

#[allow(clippy::too_many_arguments)]
fn writer_loop(
    connection: &mut Connection,
    critical_receiver: Receiver<DatabaseJob>,
    normal_receiver: Receiver<DatabaseJob>,
    telemetry_receiver: Receiver<ActorStateWrite>,
    wake_receiver: Receiver<()>,
    stop: &AtomicBool,
    last_error: &Arc<Mutex<Option<String>>>,
    metrics: &WriterMetrics,
) {
    let mut writes_since_checkpoint = 0_u64;
    let mut last_checkpoint = Instant::now();
    loop {
        let mut worked = false;

        for _ in 0..CRITICAL_BURST {
            match critical_receiver.try_recv() {
                Ok(job) => {
                    metrics.critical_queue_depth.fetch_sub(1, Ordering::AcqRel);
                    job(connection);
                    metrics.critical_writes.fetch_add(1, Ordering::Relaxed);
                    writes_since_checkpoint = writes_since_checkpoint.saturating_add(1);
                    worked = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        if let Ok(job) = normal_receiver.try_recv() {
            metrics.normal_queue_depth.fetch_sub(1, Ordering::AcqRel);
            job(connection);
            metrics.normal_writes.fetch_add(1, Ordering::Relaxed);
            writes_since_checkpoint = writes_since_checkpoint.saturating_add(1);
            worked = true;
        }

        if let Ok(first) = telemetry_receiver.try_recv() {
            metrics.telemetry_queue_depth.fetch_sub(1, Ordering::AcqRel);
            let mut snapshots = HashMap::from([(first.stable_id.clone(), first)]);
            let mut received = 1_usize;
            while received < MAX_TELEMETRY_BATCH {
                match telemetry_receiver.try_recv() {
                    Ok(snapshot) => {
                        metrics.telemetry_queue_depth.fetch_sub(1, Ordering::AcqRel);
                        snapshots.insert(snapshot.stable_id.clone(), snapshot);
                        received += 1;
                    }
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            }
            let written = snapshots.len() as u64;
            if let Err(error) = write_actor_snapshot_batch(connection, snapshots.into_values()) {
                record_error(last_error, format!("TELEMETRY_BATCH: {error}"));
            } else {
                metrics
                    .telemetry_writes
                    .fetch_add(written, Ordering::Relaxed);
                metrics.telemetry_batches.fetch_add(1, Ordering::Relaxed);
                writes_since_checkpoint = writes_since_checkpoint.saturating_add(written);
            }
            metrics
                .telemetry_completed
                .fetch_add(received as u64, Ordering::Release);
            worked = true;
        }

        if writes_since_checkpoint >= CHECKPOINT_WRITES
            || (writes_since_checkpoint > 0 && last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL)
        {
            match passive_checkpoint(connection) {
                Ok(()) => {
                    metrics.checkpoint_count.fetch_add(1, Ordering::Relaxed);
                    writes_since_checkpoint = 0;
                    last_checkpoint = Instant::now();
                }
                Err(error) => record_error(last_error, format!("WAL_CHECKPOINT: {error}")),
            }
        }

        let drained = metrics.critical_queue_depth.load(Ordering::Acquire) == 0
            && metrics.normal_queue_depth.load(Ordering::Acquire) == 0
            && metrics.telemetry_queue_depth.load(Ordering::Acquire) == 0;
        if stop.load(Ordering::Acquire) && drained {
            break;
        }

        if !worked {
            match wake_receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    if let Err(error) = passive_checkpoint(connection) {
        record_error(last_error, format!("FINAL_WAL_CHECKPOINT: {error}"));
    } else {
        metrics.checkpoint_count.fetch_add(1, Ordering::Relaxed);
    }
}

fn verify_integrity(connection: &Connection, metrics: &WriterMetrics) -> Result<(), String> {
    metrics.integrity_checks.fetch_add(1, Ordering::Relaxed);
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        metrics.integrity_failures.fetch_add(1, Ordering::Relaxed);
        Err(format!("DATABASE_INTEGRITY_FAILED: {result}"))
    }
}

fn passive_checkpoint(connection: &Connection) -> Result<(), String> {
    connection
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))
        .map_err(|error| error.to_string())
}

fn record_error(slot: &Arc<Mutex<Option<String>>>, error: String) {
    if let Ok(mut current) = slot.lock() {
        *current = Some(error);
    }
}

fn update_max(maximum: &AtomicUsize, candidate: usize) {
    let mut current = maximum.load(Ordering::Relaxed);
    while candidate > current {
        match maximum.compare_exchange_weak(
            current,
            candidate,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

fn write_actor_snapshot_batch(
    connection: &mut Connection,
    snapshots: impl Iterator<Item = ActorStateWrite>,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    {
        let mut statement = transaction
            .prepare_cached(
                "INSERT INTO printer_actor_state(
                     stable_id,printer_id,model_id,host,active_port,session_epoch,phase,
                     firmware_signature,capabilities_json,cached_status_json,last_eventtime,
                     last_seen_at,updated_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(stable_id) DO UPDATE SET
                     printer_id=excluded.printer_id,model_id=excluded.model_id,host=excluded.host,
                     active_port=excluded.active_port,session_epoch=excluded.session_epoch,
                     phase=excluded.phase,firmware_signature=excluded.firmware_signature,
                     capabilities_json=excluded.capabilities_json,
                     cached_status_json=excluded.cached_status_json,
                     last_eventtime=excluded.last_eventtime,last_seen_at=excluded.last_seen_at,
                     updated_at=excluded.updated_at
                 WHERE excluded.session_epoch>=printer_actor_state.session_epoch",
            )
            .map_err(|error| error.to_string())?;
        let mut rollup = transaction
            .prepare_cached(
                "INSERT INTO telemetry_rollups_hourly(
                     stable_id,bucket_start,samples,online_samples,average_latency_ms,
                     maximum_latency_ms,packet_loss,reconnects,payload_json,updated_at
                 ) VALUES(?1,?2,1,?3,NULL,NULL,?4,?5,?6,?7)
                 ON CONFLICT(stable_id,bucket_start) DO UPDATE SET
                     samples=telemetry_rollups_hourly.samples+1,
                     online_samples=telemetry_rollups_hourly.online_samples+excluded.online_samples,
                     packet_loss=CAST(
                         (telemetry_rollups_hourly.samples*telemetry_rollups_hourly.packet_loss)
                         +excluded.packet_loss AS REAL
                     )/(telemetry_rollups_hourly.samples+1),
                     reconnects=telemetry_rollups_hourly.reconnects+excluded.reconnects,
                     payload_json=excluded.payload_json,
                     updated_at=excluded.updated_at",
            )
            .map_err(|error| error.to_string())?;
        for snapshot in snapshots {
            let accepted = statement
                .execute(params![
                    snapshot.stable_id,
                    snapshot.printer_id,
                    snapshot.model_id,
                    snapshot.host,
                    snapshot.active_port as i64,
                    snapshot.session_epoch as i64,
                    snapshot.phase,
                    snapshot.firmware_signature,
                    snapshot.capabilities_json,
                    snapshot.cached_status_json,
                    snapshot.last_eventtime,
                    snapshot.last_seen_at,
                    snapshot.updated_at,
                ])
                .map_err(|error| error.to_string())?;
            if accepted == 0 {
                // An older worker cannot replace either the current snapshot
                // or its hourly telemetry/reconnect observations.
                continue;
            }
            let bucket_start = snapshot
                .updated_at
                .saturating_sub(snapshot.updated_at.rem_euclid(60 * 60 * 1_000));
            let online = i64::from(
                snapshot.last_seen_at.is_some_and(|last_seen| {
                    snapshot.updated_at.saturating_sub(last_seen) <= 30_000
                }) && !matches!(
                    snapshot.phase.as_str(),
                    "discovered" | "recovering" | "quarantined"
                ),
            );
            let reconnect = i64::from(snapshot.phase == "recovering");
            let packet_loss = if online == 1 { 0.0 } else { 1.0 };
            let rollup_payload = serde_json::json!({
                "phase":snapshot.phase,
                "sessionEpoch":snapshot.session_epoch,
                "activePort":snapshot.active_port,
            })
            .to_string();
            rollup
                .execute(params![
                    snapshot.stable_id,
                    bucket_start,
                    online,
                    packet_loss,
                    reconnect,
                    rollup_payload,
                    snapshot.updated_at,
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn delayed_old_actor_snapshot_cannot_overwrite_reserved_session_or_new_telemetry() {
        let path = database_path("epoch-order");
        let mut connection = Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        let current = ActorStateWrite {
            stable_id: "epoch-order".into(), printer_id: "epoch-order".into(), model_id: None,
            host: "127.0.0.1:7125".into(), active_port: 7125, session_epoch: 49,
            phase: "ready".into(), firmware_signature: None, capabilities_json: "{}".into(),
            cached_status_json: "{\"extruder\":{\"temperature\":24}}".into(),
            last_eventtime: Some(2.0), last_seen_at: Some(2), updated_at: 2,
        };
        write_actor_snapshot_batch(&mut connection, [current.clone()].into_iter()).unwrap();
        let mut delayed = current.clone();
        delayed.session_epoch = 48;
        delayed.phase = "recovering".into();
        delayed.cached_status_json = "{\"extruder\":{\"temperature\":999}}".into();
        delayed.updated_at = 3;
        write_actor_snapshot_batch(&mut connection, [delayed].into_iter()).unwrap();
        let saved: (i64, String) = connection.query_row(
            "SELECT session_epoch,cached_status_json FROM printer_actor_state WHERE stable_id='epoch-order'",
            [], |row| Ok((row.get(0)?, row.get(1)?))
        ).unwrap();
        assert_eq!(saved, (49, current.cached_status_json));
        let rollup: (i64, i64, String) = connection.query_row(
            "SELECT samples,reconnects,payload_json FROM telemetry_rollups_hourly WHERE stable_id='epoch-order'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).unwrap();
        assert_eq!(rollup.0, 1);
        assert_eq!(rollup.1, 0);
        let payload: serde_json::Value = serde_json::from_str(&rollup.2).unwrap();
        assert_eq!(payload.get("sessionEpoch"), Some(&serde_json::json!(49)));
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    fn database_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "klipper-farm-writer-v2-{label}-{}-{}.sqlite",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn critical_ack_normal_lane_and_coalesced_telemetry_work() {
        let path = database_path("lanes");
        let mut connection = Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        connection
            .execute("CREATE TABLE writer_test(value TEXT NOT NULL)", [])
            .unwrap();
        drop(connection);
        let writer = DatabaseWriter::new(&path).unwrap();
        writer
            .normal(|connection| {
                connection
                    .execute("INSERT INTO writer_test(value) VALUES('normal')", [])
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let changed = writer
            .critical(|connection| {
                connection
                    .execute("INSERT INTO writer_test(value) VALUES('critical')", [])
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(changed, 1);
        for updated_at in 1..=8 {
            writer
                .actor_snapshot(ActorStateWrite {
                    stable_id: "stable-1".into(),
                    printer_id: "printer-1".into(),
                    model_id: None,
                    host: "127.0.0.1".into(),
                    active_port: 7125,
                    session_epoch: 1,
                    phase: "ready".into(),
                    firmware_signature: None,
                    capabilities_json: "{}".into(),
                    cached_status_json: "{}".into(),
                    last_eventtime: None,
                    last_seen_at: Some(updated_at),
                    updated_at,
                })
                .unwrap();
        }
        writer.flush_telemetry().unwrap();
        let connection = Connection::open(&path).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM writer_test", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let rollups: i64 = connection
            .query_row("SELECT COUNT(*) FROM telemetry_rollups_hourly", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rollups, 1);
        let snapshot = writer.snapshot();
        assert_eq!(snapshot.telemetry_submitted, 8);
        assert_eq!(snapshot.telemetry_completed, 8);
        assert!(snapshot.integrity_checks >= 1);
        drop(connection);
        drop(writer);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn shutdown_drains_every_accepted_telemetry_snapshot() {
        let path = database_path("shutdown-drain");
        let mut connection = Connection::open(&path).unwrap();
        super::super::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);

        let writer = DatabaseWriter::new(&path).unwrap();
        writer
            .actor_snapshot(ActorStateWrite {
                stable_id: "stable-drain".into(),
                printer_id: "printer-drain".into(),
                model_id: None,
                host: "127.0.0.1".into(),
                active_port: 7125,
                session_epoch: 1,
                phase: "ready".into(),
                firmware_signature: None,
                capabilities_json: "{}".into(),
                cached_status_json: "{}".into(),
                last_eventtime: None,
                last_seen_at: Some(10),
                updated_at: 10,
            })
            .unwrap();
        drop(writer);

        let connection = Connection::open(&path).unwrap();
        let state_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM printer_actor_state WHERE stable_id='stable-drain'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let rollup_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM telemetry_rollups_hourly WHERE stable_id='stable-drain'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((state_rows, rollup_rows), (1, 1));
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
