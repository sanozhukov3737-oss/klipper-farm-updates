use super::{farm_services, CoreInner, TransactionalCore};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

const COORDINATOR_INTERVAL: Duration = Duration::from_secs(2);
const HOUSEKEEPING_INTERVAL: Duration = Duration::from_secs(60 * 60);
// The daily deadline belongs to the verified backup on disk, not this process.
// A cheap periodic check keeps the same deadline after an application restart.
const BACKUP_CHECK_INTERVAL: Duration = Duration::from_secs(60);

pub(super) fn start(inner: &Arc<CoreInner>) -> Result<(), String> {
    if inner
        .coordinator_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    let runtime = match inner.runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            inner.coordinator_started.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let owner = format!("farm-{}-{}", std::process::id(), crate::now_ms().max(0));
    let weak = Arc::downgrade(inner);
    let worker_runtime = runtime.clone();
    runtime.spawn(async move { coordinator_loop(weak, owner, worker_runtime).await });
    Ok(())
}

async fn coordinator_loop(
    inner: Weak<CoreInner>,
    owner: String,
    runtime: super::engine_runtime::EngineRuntime,
) {
    let mut last_housekeeping = Instant::now() - HOUSEKEEPING_INTERVAL;
    let mut last_backup_check = Instant::now() - BACKUP_CHECK_INTERVAL;
    let mut interval = tokio::time::interval(COORDINATOR_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Some(inner) = inner.upgrade() else {
            break;
        };
        if inner.runtime_stop.load(Ordering::Acquire) {
            break;
        }
        let run_housekeeping = last_housekeeping.elapsed() >= HOUSEKEEPING_INTERVAL;
        let run_backup = last_backup_check.elapsed() >= BACKUP_CHECK_INTERVAL;
        let owner = owner.clone();
        let result = runtime
            .run_blocking(move || {
                let core = TransactionalCore { inner };
                farm_services::coordinator_tick(&core, &owner)?;
                let reconciled = super::workflow::reconcile(&core.journal()?, crate::now_ms())?;
                if reconciled > 0 {
                    crate::observability::record(
                        "info",
                        "workflow_reconciler",
                        "WORKFLOWS_RECONCILED",
                        None,
                        "Durable workflows reconciled from command evidence",
                        serde_json::json!({"count":reconciled}),
                    );
                }
                if run_housekeeping {
                    let journal = core.journal()?;
                    let now = crate::now_ms();
                    let removed_temporary_files =
                        super::backup::cleanup_abandoned_temporaries(journal.database_path())?;
                    if removed_temporary_files > 0 {
                        eprintln!(
                            "Klipper Farm backup cleanup: removed {removed_temporary_files} abandoned temporary files"
                        );
                    }
                    let report = journal.housekeeping(now, 90)?;
                    let _ = super::command_inbox::prune(
                        &journal,
                        now.saturating_sub(30_i64 * 24 * 60 * 60 * 1_000),
                    )?;
                    if report.archived_commands > 0
                        || report.expired_archives > 0
                        || report.expired_events > 0
                        || report.expired_maintenance_rows > 0
                        || report.expired_farm_jobs > 0
                    {
                        eprintln!("Klipper Farm housekeeping: {report:?}");
                        // Возвращаем освободившиеся страницы файлу раз в сутки. Без этого
                        // удалённые строки остаются в freelist, и файл базы только растёт:
                        // на живой ферме так накопилось 844 МБ при 38 МБ мусора внутри.
                        // INCREMENTAL возвращает место частями, без полной блокировки.
                        let _ = journal.normal(|connection| {
                            connection
                                .execute_batch("PRAGMA incremental_vacuum;")
                                .map(|_| 0_i64)
                                .map_err(|error| error.to_string())
                        });
                    }
                }
                if run_backup {
                    let journal = core.journal()?;
                    journal.flush_telemetry()?;
                    if let Some(report) = super::backup::create_automatic_if_due(
                        journal.database_path(),
                        crate::now_ms(),
                    )? {
                        let drill = super::backup::restore_drill(
                            &journal,
                            std::path::Path::new(&report.path),
                            crate::now_ms(),
                        )?;
                        eprintln!(
                            "Klipper Farm verified backup: {} ({} bytes), restore drill {}",
                            report.path, report.size_bytes, drill.drill_id
                        );
                    }
                }
                Ok(())
            })
            .await;
        if let Err(error) = result {
            eprintln!("Klipper Farm FarmCoordinator: {error}");
            crate::observability::record(
                "error",
                "farm_coordinator",
                "COORDINATOR_TICK_FAILED",
                None,
                &error,
                serde_json::Value::Null,
            );
        }
        if run_housekeeping {
            last_housekeeping = Instant::now();
        }
        if run_backup {
            last_backup_check = Instant::now();
        }
    }
}
