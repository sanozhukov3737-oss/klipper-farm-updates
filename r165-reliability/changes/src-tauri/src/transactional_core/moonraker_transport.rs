use super::types::OperationPriority;
use crate::core_error::{CoreError, ErrorClass};
use kf_domain::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const FAILURE_THRESHOLD: u32 = 3;
const MAX_BACKOFF_MS: i64 = 30_000;

#[derive(Debug, Clone)]
pub(crate) struct MoonrakerRpcRequest {
    pub stable_id: String,
    pub host: String,
    pub api_key: Option<SecretString>,
    pub method: String,
    pub params: Option<Value>,
    pub prefer_rest: bool,
    pub timeout_ms: u64,
    pub default_port: u16,
    pub priority: OperationPriority,
    pub cancellation: kf_moonraker::CancellationToken,
}

pub(crate) trait MoonrakerTransport: Send + Sync {
    fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, CoreError>;
    fn snapshot(&self) -> TransportSnapshot;
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransportSnapshot {
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub circuit_rejections: u64,
    pub tracked_printers: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct BreakerState {
    consecutive_failures: u32,
    open_until_ms: i64,
}

#[derive(Debug, Default)]
pub(crate) struct NativeMoonrakerTransport {
    breakers: Mutex<HashMap<String, BreakerState>>,
    requests: AtomicU64,
    successes: AtomicU64,
    failures: AtomicU64,
    circuit_rejections: AtomicU64,
}

struct AsyncRpcJob {
    request: MoonrakerRpcRequest,
    reply: mpsc::SyncSender<Result<Value, CoreError>>,
}

#[derive(Clone)]
struct AsyncRpcExecutor {
    sender: mpsc::SyncSender<AsyncRpcJob>,
}

static ASYNC_RPC_EXECUTOR: OnceLock<AsyncRpcExecutor> = OnceLock::new();

fn async_rpc_executor() -> &'static AsyncRpcExecutor {
    ASYNC_RPC_EXECUTOR.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<AsyncRpcJob>(256);
        let _ = std::thread::Builder::new()
            .name("klipper-farm-async-network".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(4)
                    .thread_name("klipper-farm-network-io")
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        while let Ok(job) = receiver.recv() {
                            let _ = job.reply.try_send(Err(CoreError::new(
                                "ASYNC_RUNTIME_FAILED",
                                ErrorClass::Internal,
                                false,
                                error.to_string(),
                            )));
                        }
                        return;
                    }
                };
                let ordinary = Arc::new(tokio::sync::Semaphore::new(64));
                let emergency = Arc::new(tokio::sync::Semaphore::new(8));
                while let Ok(job) = receiver.recv() {
                    let gate = if job.request.priority == OperationPriority::Emergency {
                        Arc::clone(&emergency)
                    } else {
                        Arc::clone(&ordinary)
                    };
                    runtime.spawn(async move {
                        let Ok(_permit) = gate.acquire_owned().await else {
                            let _ = job.reply.try_send(Err(CoreError::new(
                                "ASYNC_NETWORK_GATE_CLOSED",
                                ErrorClass::Internal,
                                false,
                                "Async network gate closed",
                            )));
                            return;
                        };
                        let request = job.request;
                        let result = crate::rpc_async(
                            request.host,
                            request.api_key.map(|secret| secret.expose().to_string()),
                            request.method,
                            request.params,
                            request.prefer_rest,
                            Some(request.timeout_ms),
                            request.default_port,
                            request.cancellation,
                        )
                        .await
                        .map_err(CoreError::from_legacy);
                        let _ = job.reply.try_send(result);
                    });
                }
            });
        AsyncRpcExecutor { sender }
    })
}

fn execute_async_rpc(request: MoonrakerRpcRequest) -> Result<Value, CoreError> {
    let timeout = Duration::from_millis(request.timeout_ms.clamp(250, 15_000));
    let cancellation = request.cancellation.clone();
    let (reply, response) = mpsc::sync_channel(1);
    async_rpc_executor()
        .sender
        .try_send(AsyncRpcJob { request, reply })
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => CoreError::new(
                "ASYNC_NETWORK_BACKPRESSURE",
                ErrorClass::Backpressure,
                true,
                "Async network queue is full",
            ),
            mpsc::TrySendError::Disconnected(_) => CoreError::new(
                "ASYNC_NETWORK_STOPPED",
                ErrorClass::Internal,
                false,
                "Async network executor stopped",
            ),
        })?;
    response
        .recv_timeout(timeout.saturating_add(Duration::from_millis(250)))
        .map_err(|error| {
            cancellation.cancel();
            CoreError::new(
                "ASYNC_NETWORK_RESULT_TIMEOUT",
                ErrorClass::Deadline,
                true,
                error.to_string(),
            )
        })?
}

impl NativeMoonrakerTransport {
    fn admit(&self, stable_id: &str, priority: OperationPriority, now_ms: i64) -> bool {
        if priority == OperationPriority::Emergency {
            return true;
        }
        self.breakers
            .lock()
            .map(|breakers| {
                breakers
                    .get(stable_id)
                    .is_none_or(|state| state.open_until_ms <= now_ms)
            })
            .unwrap_or(false)
    }

    fn observe_success(&self, stable_id: &str) {
        self.successes.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut breakers) = self.breakers.lock() {
            breakers.remove(stable_id);
        }
    }

    fn observe_failure(&self, stable_id: &str, now_ms: i64, error: &CoreError) {
        self.failures.fetch_add(1, Ordering::Relaxed);
        if !matches!(error.class, ErrorClass::Transport | ErrorClass::Deadline) {
            return;
        }
        // Обрыв ответа во время перезапуска Klipper — это не сетевой сбой. K1 Max и другие
        // Creality штатно перезапускают Klipper после последнего слоя, Moonraker при этом
        // доступен, а недописанный ответ обрывается. Три таких «отказа» подряд открывали
        // предохранитель на 30 секунд, и все команды к принтеру падали с CIRCUIT_OPEN.
        // Такой обрыв не накапливается: считаем его разовым, но не сбрасываем уже
        // набранные настоящие отказы.
        if error.message.contains("truncated response") {
            return;
        }
        if let Ok(mut breakers) = self.breakers.lock() {
            let state = breakers.entry(stable_id.to_string()).or_default();
            state.consecutive_failures = state.consecutive_failures.saturating_add(1);
            if state.consecutive_failures >= FAILURE_THRESHOLD {
                let exponent = state
                    .consecutive_failures
                    .saturating_sub(FAILURE_THRESHOLD)
                    .min(7);
                let backoff = 500_i64
                    .saturating_mul(1_i64 << exponent)
                    .min(MAX_BACKOFF_MS);
                state.open_until_ms = now_ms.saturating_add(backoff);
            }
        }
    }
}

impl MoonrakerTransport for NativeMoonrakerTransport {
    fn rpc(&self, request: MoonrakerRpcRequest) -> Result<Value, CoreError> {
        self.requests.fetch_add(1, Ordering::Relaxed);
        let now_ms = crate::now_ms();
        if !self.admit(&request.stable_id, request.priority, now_ms) {
            self.circuit_rejections.fetch_add(1, Ordering::Relaxed);
            return Err(CoreError::new(
                "MOONRAKER_CIRCUIT_OPEN",
                ErrorClass::Backpressure,
                true,
                "Moonraker временно изолирован после серии сетевых ошибок",
            ));
        }
        let stable_id = request.stable_id.clone();
        let result = execute_async_rpc(request);
        match &result {
            Ok(_) => self.observe_success(&stable_id),
            Err(error) => self.observe_failure(&stable_id, now_ms, error),
        }
        result
    }

    fn snapshot(&self) -> TransportSnapshot {
        TransportSnapshot {
            requests: self.requests.load(Ordering::Relaxed),
            successes: self.successes.load(Ordering::Relaxed),
            failures: self.failures.load(Ordering::Relaxed),
            circuit_rejections: self.circuit_rejections.load(Ordering::Relaxed),
            tracked_printers: self
                .breakers
                .lock()
                .map(|breakers| breakers.len())
                .unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emergency_bypasses_an_open_circuit() {
        let transport = NativeMoonrakerTransport::default();
        let error = CoreError::new("TRANSPORT_FAILURE", ErrorClass::Transport, true, "offline");
        for _ in 0..FAILURE_THRESHOLD {
            transport.observe_failure("printer-a", 100, &error);
        }
        assert!(!transport.admit("printer-a", OperationPriority::Control, 101));
        assert!(transport.admit("printer-a", OperationPriority::Emergency, 101));
    }

    #[test]
    fn successful_request_resets_the_breaker() {
        let transport = NativeMoonrakerTransport::default();
        let error = CoreError::new("TRANSPORT_FAILURE", ErrorClass::Transport, true, "offline");
        for _ in 0..FAILURE_THRESHOLD {
            transport.observe_failure("printer-a", 100, &error);
        }
        transport.observe_success("printer-a");
        assert!(transport.admit("printer-a", OperationPriority::Control, 101));
    }
}
