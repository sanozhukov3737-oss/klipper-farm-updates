use rusqlite::backup::Backup;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const BACKUP_PREFIX: &str = "farm-v20-";
const BACKUP_SUFFIX: &str = ".sqlite3";
// Три копии вместо семи: 7 x 844 МБ = 5.7 ГБ на диске. Каждая копия остаётся
// полной и самодостаточной, поэтому восстановление не зависит от цепочки.
const MAX_BACKUPS: usize = 3;
const AUTOMATIC_BACKUP_INTERVAL_MS: i64 = 24 * 60 * 60 * 1_000;
static BACKUP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupReport {
    pub path: String,
    pub size_bytes: u64,
    pub integrity: String,
    pub removed_old_backups: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreDrillReport {
    pub drill_id: String,
    pub backup_sha256: String,
    pub schema_version: i64,
    pub row_counts: serde_json::Value,
    pub status: String,
}

pub(crate) fn create_on_demand(database_path: &Path, now_ms: i64) -> Result<BackupReport, String> {
    let _backup_guard = BACKUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    create_locked(database_path, now_ms)
}

/// Completed snapshots, rather than process uptime, determine the daily schedule.
/// The inspection reads SQLite headers and schema metadata, not a full integrity scan.
#[cfg(test)]
pub(crate) fn automatic_backup_due(database_path: &Path, now_ms: i64) -> Result<bool, String> {
    let _backup_guard = BACKUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    automatic_backup_due_locked(database_path, now_ms)
}

/// Keep the due check and publication together, including concurrent manual backups.
pub(crate) fn create_automatic_if_due(
    database_path: &Path,
    now_ms: i64,
) -> Result<Option<BackupReport>, String> {
    let _backup_guard = BACKUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if automatic_backup_due_locked(database_path, now_ms)? {
        create_locked(database_path, now_ms).map(Some)
    } else {
        Ok(None)
    }
}

fn create_locked(database_path: &Path, now_ms: i64) -> Result<BackupReport, String> {
    let source_metadata = fs::symlink_metadata(database_path)
        .map_err(|error| format!("BACKUP_SOURCE_UNAVAILABLE: {error}"))?;
    if !source_metadata.file_type().is_file() {
        return Err("BACKUP_SOURCE_NOT_REGULAR: рабочая база не является обычным файлом".into());
    }
    // Never create a missing live database or publish an empty SQLite file as a backup.
    let source = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("BACKUP_SOURCE_OPEN_FAILED: {error}"))?;
    source
        .execute_batch("PRAGMA busy_timeout=5000; PRAGMA query_only=ON;")
        .map_err(|error| error.to_string())?;
    let source_version = super::migrations::current_version(&source)?;
    if source_version != super::migrations::SCHEMA_VERSION {
        return Err(format!("BACKUP_SOURCE_SCHEMA_MISMATCH: expected 20, got {source_version}"));
    }
    let data_dir = database_path
        .parent()
        .ok_or("Путь SQLite не содержит каталог данных")?;
    let backup_dir = data_dir.join("backups");
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    secure_directory(&backup_dir)?;
    let (final_path, partial_path) = unused_backup_paths(&backup_dir, now_ms.max(0))?;
    // Reserve without following or replacing an existing file, including a dangling link.
    drop(OpenOptions::new().write(true).create_new(true).open(&partial_path)
        .map_err(|error| format!("BACKUP_RESERVE_FAILED: {error}"))?);
    let mut partial_guard = PartialBackup::new(partial_path.clone());
    crate::set_private_file_permissions(&partial_path)?;
    let mut destination = Connection::open(&partial_path).map_err(|error| error.to_string())?;
    {
        let backup = Backup::new(&source, &mut destination)
            .map_err(|error| format!("Не удалось начать online backup: {error}"))?;
        backup
            .run_to_completion(256, Duration::from_millis(5), None)
            .map_err(|error| format!("Online backup SQLite завершился ошибкой: {error}"))?;
    }
    // Online backup копирует страницы как есть, вместе с freelist: каждая копия несла
    // те же 38 МБ мусора, что и рабочая база. VACUUM на самой копии (она открыта на
    // запись и принадлежит нам) пересобирает файл без свободных страниц.
    destination
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
        .map_err(|error| error.to_string())?;
    let integrity: String = destination
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        drop(destination);
        return Err(format!("BACKUP_INTEGRITY_FAILED: {integrity}"));
    }
    let destination_version = super::migrations::current_version(&destination)?;
    if destination_version != super::migrations::SCHEMA_VERSION {
        return Err(format!("BACKUP_SCHEMA_MISMATCH: expected 20, got {destination_version}"));
    }
    destination
        .close()
        .map_err(|(_, error)| format!("BACKUP_CLOSE_FAILED: {error}"))?;
    super::durable_fs::sync_file(&partial_path)?;
    super::durable_fs::rename_atomic(&partial_path, &final_path)?;
    partial_guard.committed = true;
    sync_directory(&backup_dir)?;
    let size_bytes = fs::metadata(&final_path)
        .map_err(|error| error.to_string())?
        .len();
    if size_bytes == 0 {
        return Err("BACKUP_EMPTY: создан пустой файл backup".into());
    }
    let removed_old_backups = rotate_backups(&backup_dir, &final_path)?;
    Ok(BackupReport {
        path: final_path.to_string_lossy().into_owned(),
        size_bytes,
        integrity,
        removed_old_backups,
    })
}

pub(crate) fn restore_drill(
    journal: &super::journal::Journal,
    backup_path: &Path,
    now_ms: i64,
) -> Result<RestoreDrillReport, String> {
    let _backup_guard = BACKUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let drill_id = format!(
        "drill-{}-{}",
        now_ms.max(0),
        hex::encode(crate::random_bytes::<8>()?)
    );
    let directory = backup_path
        .parent()
        .ok_or("Backup path does not contain a parent directory")?;
    let restored_path = directory.join(format!(".{drill_id}.restore.partial"));
    let destination = OpenOptions::new().write(true).create_new(true).open(&restored_path)
        .map_err(|error| format!("RESTORE_DRILL_RESERVE_FAILED: {error}"))?;
    let _guard = RestoreDrillGuard(restored_path.clone());
    let mut destination = destination;
    crate::set_private_file_permissions(&restored_path)?;
    {
        let mut source = OpenOptions::new().read(true).open(backup_path)
            .map_err(|error| format!("RESTORE_DRILL_COPY_FAILED: {error}"))?;
        io::copy(&mut source, &mut destination)
            .map_err(|error| format!("RESTORE_DRILL_COPY_FAILED: {error}"))?;
    }
    drop(destination);
    super::durable_fs::sync_file(&restored_path)
        .map_err(|error| format!("RESTORE_DRILL_FSYNC_FAILED: {error}"))?;
    let backup_sha256 = hash_file(&restored_path)?;
    let restored = open_immutable_snapshot(&restored_path)
    .map_err(|error| format!("RESTORE_DRILL_OPEN_FAILED: {error}"))?;
    restored
        .execute_batch("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())?;
    let quick_check: String = restored
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if quick_check != "ok" {
        return Err(format!("RESTORE_DRILL_INTEGRITY_FAILED: {quick_check}"));
    }
    let schema_version = super::migrations::current_version(&restored)?;
    if schema_version != 20 {
        return Err(format!(
            "RESTORE_DRILL_SCHEMA_MISMATCH: expected 20, got {schema_version}"
        ));
    }
    let mut counts = serde_json::Map::new();
    for table in [
        "printer_actor_state",
        "command_journal",
        "durable_workflows",
        "farm_queue_v2",
        "audit",
        "audit_chain",
    ] {
        let count: i64 = restored
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        counts.insert(table.to_string(), serde_json::Value::from(count.max(0)));
    }
    let row_counts = serde_json::Value::Object(counts);
    restored
        .close()
        .map_err(|(_, error)| format!("RESTORE_DRILL_CLOSE_FAILED: {error}"))?;
    let row_counts_json = serde_json::to_string(&row_counts).map_err(|error| error.to_string())?;
    let backup_path_text = backup_path.to_string_lossy().into_owned();
    let drill_id_for_write = drill_id.clone();
    let digest_for_write = backup_sha256.clone();
    journal.critical(move |connection| {
        connection
            .execute(
                "INSERT INTO backup_restore_drills(
                     drill_id,backup_path,backup_sha256,quick_check,schema_version,row_counts_json,
                     started_at,completed_at,status,error
                 ) VALUES(?1,?2,?3,'ok',?4,?5,?6,?6,'passed',NULL)",
                params![
                    drill_id_for_write,
                    backup_path_text,
                    digest_for_write,
                    schema_version,
                    row_counts_json,
                    now_ms,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    })?;
    Ok(RestoreDrillReport {
        drill_id,
        backup_sha256,
        schema_version,
        row_counts,
        status: "passed".into(),
    })
}

struct RestoreDrillGuard(PathBuf);

impl Drop for RestoreDrillGuard {
    fn drop(&mut self) {
        remove_temporary_family(&self.0, true);
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut block = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut block).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&block[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

struct PartialBackup {
    path: PathBuf,
    committed: bool,
}

impl PartialBackup {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }
}

impl Drop for PartialBackup {
    fn drop(&mut self) {
        remove_temporary_family(&self.path, !self.committed);
    }
}

fn backup_directory(database_path: &Path) -> Result<PathBuf, String> {
    database_path.parent().map(|parent| parent.join("backups"))
        .ok_or_else(|| "Путь SQLite не содержит каталог данных".into())
}

fn timestamp_from_discriminator(value: &str) -> Option<i64> {
    let (timestamp, collision) = value.split_once('-')
        .map_or((value, None), |(timestamp, collision)| (timestamp, Some(collision)));
    if timestamp.is_empty() || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || (timestamp.len() > 1 && timestamp.starts_with('0'))
        || collision.is_some_and(|suffix| suffix.len() != 4 || !suffix.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    timestamp.parse::<i64>().ok()
}

fn backup_timestamp(name: &str) -> Option<i64> {
    timestamp_from_discriminator(name.strip_prefix(BACKUP_PREFIX)?.strip_suffix(BACKUP_SUFFIX)?)
}

fn automatic_backup_due_locked(database_path: &Path, now_ms: i64) -> Result<bool, String> {
    let directory = backup_directory(database_path)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("BACKUP_SCHEDULE_READ_FAILED: {error}")),
    };
    let now_ms = now_ms.max(0);
    let mut recent = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(timestamp) = name.to_str().and_then(backup_timestamp) else { continue };
        // A clock rollback must not let a future-dated file suppress backups indefinitely.
        if timestamp <= now_ms && now_ms.saturating_sub(timestamp) < AUTOMATIC_BACKUP_INTERVAL_MS {
            recent.push((timestamp, entry.path()));
        }
    }
    recent.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, path) in recent {
        if snapshot_has_expected_metadata(&path) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn snapshot_has_expected_metadata(path: &Path) -> bool {
    let check = || -> Result<bool, String> {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !metadata.file_type().is_file() || metadata.len() < 100 {
            return Ok(false);
        }
        let mut header = [0_u8; 16];
        OpenOptions::new().read(true).open(path)
            .and_then(|mut file| file.read_exact(&mut header))
            .map_err(|error| error.to_string())?;
        if &header != b"SQLite format 3\0" {
            return Ok(false);
        }
        // Immutable snapshots cannot create -wal/-shm while checking the schedule.
        let connection = open_immutable_snapshot(path)?;
        let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let version = super::migrations::current_version(&connection)?;
        Ok(version == super::migrations::SCHEMA_VERSION && page_size > 0 && page_count > 0
            && (page_size as u64).checked_mul(page_count as u64) == Some(metadata.len()))
    };
    check().unwrap_or(false)
}

fn open_immutable_snapshot(path: &Path) -> Result<Connection, String> {
    let absolute = fs::canonicalize(path).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let bytes = {
        let text = absolute.to_str().ok_or("Путь backup не представлен в UTF-8")?;
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        let text = if let Some(unc) = text.strip_prefix(r"UNC\") {
            format!("//{unc}")
        } else {
            text.to_string()
        }.replace('\\', "/");
        // Empty URI authority: local drive uses /C:/; UNC uses //server/share.
        let text = if text.starts_with("//") { format!("//{text}") } else { format!("///{text}") };
        text.into_bytes()
    };
    #[cfg(not(windows))]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        let mut bytes = b"//".to_vec();
        bytes.extend_from_slice(absolute.as_os_str().as_bytes());
        bytes
    };
    let mut uri = String::from("file:");
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || b"/:-._~".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri.push_str("?immutable=1");
    Connection::open_with_flags(uri, OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI)
        .map_err(|error| error.to_string())
}

fn is_owned_temporary(name: &str) -> bool {
    let base = ["-wal", "-shm", "-journal"].iter()
        .find_map(|suffix| name.strip_suffix(*suffix)).unwrap_or(name);
    if let Some(discriminator) = base.strip_prefix(".farm-v20-").and_then(|name| name.strip_suffix(".partial")) {
        return timestamp_from_discriminator(discriminator).is_some();
    }
    let Some(drill) = base.strip_prefix(".drill-").and_then(|name| name.strip_suffix(".restore.partial")) else { return false };
    let Some((timestamp, nonce)) = drill.rsplit_once('-') else { return false };
    timestamp_from_discriminator(timestamp).is_some()
        && !timestamp.contains('-') && nonce.len() == 16 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Called only while this engine owns the database and no backup/drill is active.
/// Directory junctions are supported, but individual links and nested directories are untouched.
pub(crate) fn cleanup_abandoned_temporaries(database_path: &Path) -> Result<usize, String> {
    let _backup_guard = BACKUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let directory = backup_directory(database_path)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("BACKUP_TEMPORARY_SCAN_FAILED: {error}")),
    };
    let mut removed = 0;
    let mut failure = None;
    for entry in entries {
        let result = (|| -> Result<bool, String> {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().map_err(|error| error.to_string())?.is_file()
                || !entry.file_name().to_str().is_some_and(is_owned_temporary)
            {
                return Ok(false);
            }
            remove_regular_file(&entry.path()).map_err(|error| error.to_string())
        })();
        match result {
            Ok(true) => removed += 1,
            Ok(false) => {},
            Err(error) => { failure.get_or_insert(error); },
        }
    }
    if let Some(error) = failure {
        Err(format!("BACKUP_TEMPORARY_CLEANUP_FAILED: {error}; removed {removed}"))
    } else {
        Ok(removed)
    }
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn remove_regular_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path).map(|()| true),
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_temporary_family(path: &Path, remove_base: bool) {
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = remove_regular_file(&sidecar_path(path, suffix));
    }
    if remove_base {
        let _ = remove_regular_file(path);
    }
}

fn unused_backup_paths(directory: &Path, now_ms: i64) -> Result<(PathBuf, PathBuf), String> {
    for suffix in 0..10_000_u32 {
        let discriminator = if suffix == 0 {
            now_ms.to_string()
        } else {
            format!("{now_ms}-{suffix:04}")
        };
        let final_path = directory.join(format!("{BACKUP_PREFIX}{discriminator}{BACKUP_SUFFIX}"));
        let partial_path = directory.join(format!(".{BACKUP_PREFIX}{discriminator}.partial"));
        if path_is_unused(&final_path)? && path_is_unused(&partial_path)? {
            return Ok((final_path, partial_path));
        }
    }
    Err("BACKUP_NAME_EXHAUSTED: не удалось выбрать уникальное имя backup".into())
}

fn path_is_unused(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

fn rotate_backups(directory: &Path, current: &Path) -> Result<usize, String> {
    let mut backups = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_str().and_then(backup_timestamp).is_some()
        })
        .map(|entry| {
            let modified = entry.metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            (modified, entry.path())
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let remove_count = backups.len().saturating_sub(MAX_BACKUPS);
    let mut removed = 0;
    for (_, path) in backups
        .into_iter()
        .filter(|(_, path)| path != current)
    {
        if removed >= remove_count {
            break;
        }
        if remove_regular_file(&path).unwrap_or(false) {
            removed += 1;
        }
    }
    if removed < remove_count {
        eprintln!("Klipper Farm backup retention: removed {removed} of {remove_count} old copies; remaining files may be locked");
    }
    Ok(removed)
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transactional_core::migrations;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SERIAL: AtomicU64 = AtomicU64::new(0);

    fn test_directory(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "klipper-farm-backup-{label}-{}-{}-{}",
            std::process::id(), crate::now_ms(), TEST_SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn seed_database(root: &Path) -> PathBuf {
        fs::create_dir_all(root).unwrap();
        let path = root.join("farm.sqlite3");
        let mut connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        crate::database::initialize_base_schema(&connection).unwrap();
        migrations::migrate(&mut connection, 1).unwrap();
        connection.execute_batch(
            "CREATE TABLE backup_probe(value TEXT NOT NULL);
             INSERT INTO backup_probe(value) VALUES('принтеры, пластик и тарифы');"
        ).unwrap();
        drop(connection);
        path
    }

    fn directory_names(directory: &Path) -> Vec<std::ffi::OsString> {
        let mut names = fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().file_name()).collect::<Vec<_>>();
        names.sort();
        names
    }

    fn assert_probe(path: &Path) {
        let connection = open_immutable_snapshot(path).unwrap();
        let value: String = connection.query_row("SELECT value FROM backup_probe", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "принтеры, пластик и тарифы");
    }

    #[test]
    fn automatic_backup_survives_restarts_and_obeys_daily_boundary() {
        let root = test_directory("schedule");
        let database = seed_database(&root);
        let now = 1_000_000;
        assert!(automatic_backup_due(&database, now).unwrap());
        let first = create_automatic_if_due(&database, now).unwrap().unwrap();
        assert_probe(Path::new(&first.path));
        let names = directory_names(&root.join("backups"));
        for elapsed in [0, 1, 60_000, 3_600_000, AUTOMATIC_BACKUP_INTERVAL_MS - 1] {
            // No in-memory state survives these independent calls.
            assert!(!automatic_backup_due(&database, now + elapsed).unwrap());
            assert!(create_automatic_if_due(&database, now + elapsed).unwrap().is_none());
            assert_eq!(directory_names(&root.join("backups")), names);
        }
        let next = create_automatic_if_due(&database, now + AUTOMATIC_BACKUP_INTERVAL_MS).unwrap().unwrap();
        assert_ne!(next.path, first.path);
        assert_probe(Path::new(&next.path));
        assert_eq!(directory_names(&root.join("backups")).len(), 2);
        fs::remove_file(&next.path).unwrap();
        assert!(automatic_backup_due(&database, now + AUTOMATIC_BACKUP_INTERVAL_MS).unwrap());
        let replacement = create_automatic_if_due(&database, now + AUTOMATIC_BACKUP_INTERVAL_MS).unwrap().unwrap();
        assert_probe(Path::new(&replacement.path));
        assert_probe(&database);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn automatic_backup_ignores_future_empty_corrupt_truncated_and_foreign_files() {
        let root = test_directory("invalid-schedule");
        let database = seed_database(&root);
        let now = 10_000_000;
        let future = create_on_demand(&database, now + AUTOMATIC_BACKUP_INTERVAL_MS).unwrap();
        let directory = root.join("backups");
        fs::write(directory.join(format!("farm-v20-{now}.sqlite3")), []).unwrap();
        let mut bad_header = vec![0; 4_096];
        bad_header[..16].copy_from_slice(b"SQLite format 3\0");
        fs::write(directory.join(format!("farm-v20-{}.sqlite3", now - 1)), bad_header).unwrap();
        let truncated = directory.join(format!("farm-v20-{}.sqlite3", now - 2));
        fs::copy(&future.path, &truncated).unwrap();
        OpenOptions::new().write(true).open(&truncated).unwrap().set_len(100).unwrap();
        let wrong_schema = directory.join(format!("farm-v20-{}.sqlite3", now - 3));
        Connection::open(&wrong_schema).unwrap().execute_batch("CREATE TABLE unrelated(value TEXT);").unwrap();
        fs::copy(&future.path, directory.join("farm-v20-user-copy.sqlite3")).unwrap();
        assert!(automatic_backup_due(&database, now).unwrap());
        let report = create_automatic_if_due(&database, now).unwrap().unwrap();
        assert_probe(Path::new(&report.path));
        assert!(!automatic_backup_due(&database, now).unwrap());
        // Лимит копий теперь MAX_BACKUPS, поэтому самый старый файл может быть вытеснен.
        // Важно другое: новый снимок создан, пользовательская копия не тронута,
        // а число собственных копий не превышает лимит.
        assert!(Path::new(&report.path).exists());
        let owned = directory_names(&directory).into_iter()
            .filter(|name| backup_timestamp(&name.to_string_lossy()).is_some()).count();
        assert!(owned <= MAX_BACKUPS, "собственных копий не больше лимита");
        assert!(directory.join("farm-v20-user-copy.sqlite3").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schedule_inspection_and_restore_use_immutable_paths_with_spaces_unicode_and_uri_characters() {
        let root = test_directory("immutable").join("данные #100%");
        let database = seed_database(&root);
        let report = create_on_demand(&database, 100).unwrap();
        let directory = root.join("backups");
        let before = directory_names(&directory);
        for _ in 0..3 {
            assert!(!automatic_backup_due(&database, 200).unwrap());
            assert!(create_automatic_if_due(&database, 200).unwrap().is_none());
        }
        assert_probe(Path::new(&report.path));
        assert_eq!(directory_names(&directory), before);
        let parent = root.parent().unwrap().to_path_buf();
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn abandoned_temporary_cleanup_removes_only_owned_regular_files_and_orphan_sidecars() {
        let root = test_directory("cleanup");
        let database = seed_database(&root);
        let directory = root.join("backups");
        fs::create_dir(&directory).unwrap();
        let owned = [
            ".farm-v20-42.partial", ".farm-v20-42.partial-wal", ".farm-v20-42.partial-shm", ".farm-v20-42.partial-journal",
            ".farm-v20-43-0001.partial-wal", ".farm-v20-43-0001.partial-shm",
            ".drill-44-0123456789abcdef.restore.partial", ".drill-44-0123456789abcdef.restore.partial-wal",
            ".drill-44-0123456789abcdef.restore.partial-shm", ".drill-44-0123456789abcdef.restore.partial-journal",
            ".drill-45-0123456789abcdef.restore.partial-shm",
        ];
        let foreign = ["manual.partial", ".drill-46-human.restore.partial", ".farm-v20-user.partial",
            ".farm-v20-42-1.partial", "farm-v20-100.sqlite3", ".farm.pre-v19-to-v20-42.partial",
            ".drill-42-0001-0123456789abcdef.restore.partial", ".farm-v20-42.partial-shm-extra"];
        for name in owned.iter().chain(foreign.iter()) {
            fs::write(directory.join(name), b"preserve or remove only by ownership").unwrap();
        }
        let nested = directory.join(".farm-v20-999.partial");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("user-file"), b"keep").unwrap();
        let outside = root.join(".farm-v20-42.partial");
        fs::write(&outside, b"outside backup directory").unwrap();
        assert_eq!(cleanup_abandoned_temporaries(&database).unwrap(), owned.len());
        assert_eq!(cleanup_abandoned_temporaries(&database).unwrap(), 0);
        for name in owned { assert!(!directory.join(name).exists(), "left temporary: {name}"); }
        for name in foreign { assert!(directory.join(name).exists(), "removed foreign file: {name}"); }
        assert_eq!(fs::read(nested.join("user-file")).unwrap(), b"keep");
        assert!(outside.exists());
        assert_probe(&database);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_automatic_requests_publish_one_copy_and_manual_wal_backup_stays_available() {
        let root = test_directory("concurrent-wal");
        let database = seed_database(&root);
        let live = crate::database::open_connection(&database).unwrap();
        live.execute_batch(
            "PRAGMA wal_autocheckpoint=0;
             CREATE TABLE wal_backup_probe(value TEXT NOT NULL);
             INSERT INTO wal_backup_probe(value) VALUES('committed in WAL');"
        ).unwrap();
        assert!(sidecar_path(&database, "-wal").exists());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers = (0..2).map(|_| {
            let database = database.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                create_automatic_if_due(&database, 1_000).unwrap()
            })
        }).collect::<Vec<_>>();
        let reports = workers.into_iter().filter_map(|worker| worker.join().unwrap()).collect::<Vec<_>>();
        assert_eq!(reports.len(), 1);
        assert_eq!(directory_names(&root.join("backups")).len(), 1);
        let manual = create_on_demand(&database, 1_001).unwrap();
        assert_ne!(manual.path, reports[0].path);
        assert_eq!(directory_names(&root.join("backups")).len(), 2);
        for path in [&manual.path, &reports[0].path] {
            let snapshot = open_immutable_snapshot(Path::new(path)).unwrap();
            let value: String = snapshot.query_row("SELECT value FROM wal_backup_probe", [], |row| row.get(0)).unwrap();
            assert_eq!(value, "committed in WAL");
        }
        assert!(sidecar_path(&database, "-wal").exists());
        let value: String = live.query_row("SELECT value FROM wal_backup_probe", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "committed in WAL");
        drop(live);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temporary_guards_remove_base_wal_shm_and_journal_after_failure_or_commit() {
        let root = test_directory("guards");
        for (name, committed) in [(".farm-v20-1.partial", false), (".farm-v20-2.partial", true)] {
            let path = root.join(name);
            fs::write(&path, b"base").unwrap();
            for suffix in ["-wal", "-shm", "-journal"] { fs::write(sidecar_path(&path, suffix), b"sidecar").unwrap(); }
            { let _guard = PartialBackup { path: path.clone(), committed }; }
            assert_eq!(path.exists(), committed);
            for suffix in ["-wal", "-shm", "-journal"] { assert!(!sidecar_path(&path, suffix).exists()); }
        }
        let restored = root.join(".drill-1-0123456789abcdef.restore.partial");
        fs::write(&restored, b"base").unwrap();
        for suffix in ["-wal", "-shm", "-journal"] { fs::write(sidecar_path(&restored, suffix), b"sidecar").unwrap(); }
        { let _guard = RestoreDrillGuard(restored.clone()); }
        assert!(!restored.exists());
        for suffix in ["-wal", "-shm", "-journal"] { assert!(!sidecar_path(&restored, suffix).exists()); }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_or_wrong_schema_live_database_never_publishes_or_rotates_backups() {
        let root = test_directory("missing-source");
        let database = seed_database(&root);
        for now in 1..=(MAX_BACKUPS as i64 + 3) { create_on_demand(&database, now).unwrap(); }
        let directory = root.join("backups");
        let before = directory_names(&directory);
        fs::remove_file(&database).unwrap();
        assert!(create_on_demand(&database, 100).unwrap_err().contains("BACKUP_SOURCE_UNAVAILABLE"));
        assert!(!database.exists());
        assert_eq!(directory_names(&directory), before);
        let empty = Connection::open(&database).unwrap();
        empty.execute_batch("CREATE TABLE unrelated(value TEXT);").unwrap();
        drop(empty);
        assert!(create_on_demand(&database, 101).is_err());
        assert_eq!(directory_names(&directory), before);
        fs::write(&database, b"corrupt live database").unwrap();
        assert!(create_on_demand(&database, 102).is_err());
        assert_eq!(directory_names(&directory), before);
        fs::remove_file(&database).unwrap();
        fs::create_dir(&database).unwrap();
        fs::write(database.join("user-file"), b"keep").unwrap();
        assert!(create_on_demand(&database, 103).unwrap_err().contains("BACKUP_SOURCE_NOT_REGULAR"));
        assert_eq!(directory_names(&directory), before);
        assert_eq!(fs::read(database.join("user-file")).unwrap(), b"keep");
        for name in before { assert_probe(&directory.join(name)); }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restore_failure_removes_temporary_copy_without_touching_live_data() {
        let root = test_directory("restore-failure");
        let database = seed_database(&root);
        let journal = crate::transactional_core::Journal::new(&database).unwrap();
        let valid = create_on_demand(&database, 1).unwrap();
        let directory = root.join("backups");
        let corrupt = directory.join("farm-v20-2.sqlite3");
        fs::write(&corrupt, b"not a SQLite database").unwrap();
        let before = directory_names(&directory);
        assert!(restore_drill(&journal, &corrupt, 2).is_err());
        assert_eq!(directory_names(&directory), before);
        assert!(restore_drill(&journal, &directory.join("missing.sqlite3"), 3).is_err());
        assert_eq!(directory_names(&directory), before);
        assert_probe(Path::new(&valid.path));
        assert_probe(&database);
        let count: i64 = journal.read(|connection| connection.query_row(
            "SELECT COUNT(*) FROM backup_restore_drills", [], |row| row.get(0)
        ).map_err(|error| error.to_string())).unwrap();
        assert_eq!(count, 0);
        drop(journal);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_preserves_current_snapshot_and_ignores_foreign_files_and_directories() {
        let root = test_directory("retention");
        let directory = root.join("backups");
        fs::create_dir(&directory).unwrap();
        let owned = (1..=10).map(|number| directory.join(format!("farm-v20-{number}.sqlite3"))).collect::<Vec<_>>();
        for path in &owned { fs::write(path, b"owned").unwrap(); }
        let protected = owned[0].clone();
        let foreign = directory.join("farm-v20-my-saved-copy.sqlite3");
        fs::write(&foreign, b"user copy").unwrap();
        let nested = directory.join("farm-v20-1000.sqlite3");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("user-file"), b"keep").unwrap();
        assert_eq!(rotate_backups(&directory, &protected).unwrap(), 10 - MAX_BACKUPS);
        assert_eq!(owned.iter().filter(|path| path.exists()).count(), MAX_BACKUPS);
        assert!(protected.exists());
        assert_eq!(fs::read(foreign).unwrap(), b"user copy");
        assert_eq!(fs::read(nested.join("user-file")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_and_schedule_do_not_follow_individual_file_symlinks() {
        use std::os::unix::fs::symlink;
        let root = test_directory("symlinks");
        let database = seed_database(&root);
        let valid = create_on_demand(&database, 1).unwrap();
        let outside = root.join("user-file");
        fs::write(&outside, b"keep").unwrap();
        let directory = root.join("backups");
        let temporary_link = directory.join(".farm-v20-2.partial");
        symlink(&outside, &temporary_link).unwrap();
        let snapshot_link = directory.join("farm-v20-1000000000.sqlite3");
        symlink(&valid.path, &snapshot_link).unwrap();
        assert_eq!(cleanup_abandoned_temporaries(&database).unwrap(), 0);
        assert!(automatic_backup_due(&database, 1_000_000_000).unwrap());
        assert!(fs::symlink_metadata(&temporary_link).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(&snapshot_link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn backup_cleanup_and_schedule_work_through_windows_directory_junction() {
        let root = test_directory("junction");
        let app = root.join("данные приложения");
        let database = seed_database(&app);
        let target = root.join("backup target");
        fs::create_dir(&target).unwrap();
        let junction = app.join("backups");
        let output = std::process::Command::new("cmd").args(["/C", "mklink", "/J"])
            .arg(&junction).arg(&target).output().unwrap();
        assert!(output.status.success(), "mklink failed: {}", String::from_utf8_lossy(&output.stderr));
        let report = create_automatic_if_due(&database, 1).unwrap().unwrap();
        assert_probe(Path::new(&report.path));
        assert!(!automatic_backup_due(&database, 60_001).unwrap());
        fs::write(target.join(".drill-2-0123456789abcdef.restore.partial-wal"), b"orphan").unwrap();
        assert_eq!(cleanup_abandoned_temporaries(&database).unwrap(), 1);
        for now in 2..=9 { create_on_demand(&database, now).unwrap(); }
        assert_eq!(directory_names(&target).len(), MAX_BACKUPS);
        assert_probe(&database);
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retention_continues_after_an_old_locked_file_cannot_be_removed() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_directory("locked-retention");
        let owned = (1..=10).map(|number| root.join(format!("farm-v20-{number}.sqlite3"))).collect::<Vec<_>>();
        for path in &owned { fs::write(path, b"owned").unwrap(); }
        let oldest = &owned[0];
        // Permit reading/writing, but retain a real Windows sharing violation for deletion.
        let locked = OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(oldest).unwrap();
        assert!(fs::remove_file(oldest).is_err());
        assert_eq!(rotate_backups(&root, &owned[9]).unwrap(), 10 - MAX_BACKUPS);
        assert_eq!(owned.iter().filter(|path| path.exists()).count(), MAX_BACKUPS);
        assert!(oldest.exists());
        assert!(owned[9].exists());
        drop(locked);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn online_backup_is_verified_and_rotated() {
        let root = std::env::temp_dir().join(format!(
            "klipper-farm-backup-test-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("farm.sqlite3");
        let mut connection = Connection::open(&database).unwrap();
        migrations::migrate(&mut connection, 1).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE backup_probe(value TEXT NOT NULL);
                 INSERT INTO backup_probe(value) VALUES('durable');",
            )
            .unwrap();
        drop(connection);
        for _ in 1..=9 {
            let report = create_on_demand(&database, 42).unwrap();
            assert_eq!(report.integrity, "ok");
            assert!(report.size_bytes > 0);
            let backup = Connection::open(&report.path).unwrap();
            let value: String = backup
                .query_row("SELECT value FROM backup_probe", [], |row| row.get(0))
                .unwrap();
            assert_eq!(value, "durable");
        }
        let count = fs::read_dir(root.join("backups"))
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(count, MAX_BACKUPS);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_drill_reopens_a_copy_and_records_evidence() {
        let root = std::env::temp_dir().join(format!(
            "klipper-farm-restore-test-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("farm.sqlite3");
        let mut connection = Connection::open(&database).unwrap();
        crate::database::initialize_base_schema(&connection).unwrap();
        crate::transactional_core::migrations::migrate(&mut connection, 1).unwrap();
        drop(connection);
        let journal = crate::transactional_core::Journal::new(&database).unwrap();
        let backup = create_on_demand(&database, 1).unwrap();
        let before = directory_names(&root.join("backups"));
        let drill = restore_drill(&journal, Path::new(&backup.path), 2).unwrap();
        assert_eq!(drill.status, "passed");
        assert_eq!(drill.schema_version, 20);
        assert_eq!(drill.backup_sha256.len(), 64);
        assert_eq!(directory_names(&root.join("backups")), before);
        assert!(!automatic_backup_due(&database, 2).unwrap());
        let count: i64 = journal
            .read(|connection| {
                connection
                    .query_row("SELECT COUNT(*) FROM backup_restore_drills", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(count, 1);
        drop(journal);
        let _ = fs::remove_dir_all(root);
    }
}
