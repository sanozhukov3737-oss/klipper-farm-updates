use super::*;
use engine_client::EngineClient;
use transactional_core::types::{ActorSnapshot, PrinterPhase};

const MAX_INSTALLER: u64 = 512 * 1024 * 1024;
const DOWNLOAD_HEADROOM: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Channel {
    endpoint: String,
    public_key_hex: String,
    channel: String,
    installed_sequence: u64,
}

fn channel() -> Result<Channel, String> {
    let value: Channel = serde_json::from_str(include_str!("../../UPDATE-CHANNEL.json"))
        .map_err(|e| format!("Конфигурация канала обновлений: {e}"))?;
    let url = Url::parse(&value.endpoint).map_err(|e| e.to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.fragment().is_some() || value.public_key_hex.len() != 64
        || !value.public_key_hex.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(value.channel.as_str(), "stable" | "beta") || value.installed_sequence == 0
    { return Err("Некорректный встроенный канал обновления".into()); }
    Ok(value)
}

#[derive(Default)]
pub(crate) struct UpdateState {
    busy: AtomicBool,
    cancel: AtomicBool,
    pub(crate) applying: AtomicBool,
    prepared: Mutex<Option<Prepared>>,
}

#[derive(Clone)]
struct Prepared { directory: PathBuf, manifest_sha256: String }

struct Lease(AppHandle);
impl Lease {
    fn acquire(app: &AppHandle) -> Result<Self, String> {
        let state = app.state::<UpdateState>();
        state.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Операция обновления уже выполняется".to_string())?;
        state.cancel.store(false, Ordering::SeqCst);
        Ok(Self(app.clone()))
    }
}
impl Drop for Lease {
    fn drop(&mut self) { self.0.state::<UpdateState>().busy.store(false, Ordering::SeqCst); }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    version: String,
    current_version: String,
    sequence: u64,
    body: Option<String>,
    manifest_sha256: String,
    size_bytes: u64,
}
impl From<&kf_update::VerifiedManifest> for UpdateInfo {
    fn from(value: &kf_update::VerifiedManifest) -> Self {
        Self { version: value.manifest.version.clone(), current_version: env!("CARGO_PKG_VERSION").into(),
            sequence: value.manifest.sequence, body: value.manifest.release_notes.clone(),
            manifest_sha256: value.manifest_sha256.clone(), size_bytes: value.manifest.artifact.size_bytes }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus { supported: bool, current_version: String, installed_sequence: u64 }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { stage: &'static str, downloaded_bytes: u64, total_bytes: u64 }
fn progress(app: &AppHandle, stage: &'static str, downloaded: u64, total: u64) {
    let _ = app.emit("app-update-progress", Progress { stage, downloaded_bytes: downloaded, total_bytes: total });
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage_paths::subdir(app, "verified-updates")
}

fn cleanup_cache(app: &AppHandle) -> Result<(), String> {
    let prepared = app.state::<UpdateState>().prepared.lock().map_err(|_| "Updater state")?.clone();
    crate::update_cache::sweep(&cache_root(app)?, prepared.as_ref().map(|value| value.directory.as_path()))
        .map_err(|error| error.to_string())
}

pub(crate) fn cleanup_background(app: AppHandle) {
    let _ = thread::Builder::new().name("klipper-farm-update-cache".into()).spawn(move || {
        // A helper/antivirus may release the installer just after the new
        // desktop starts. Retry without holding the updater lease while idle.
        for delay in [0, 2, 5] {
            if delay > 0 { thread::sleep(Duration::from_secs(delay)); }
            if let Ok(_lease) = Lease::acquire(&app) {
                if let Err(error) = cleanup_cache(&app) { desktop_startup::record("UPDATE_CACHE_CLEANUP_DEFERRED", &error); }
            }
        }
    });
}

fn discard(app: &AppHandle, directory: &Path) {
    if let Ok(root) = cache_root(app) { let _ = crate::update_cache::remove_attempt(&root, directory); }
}

fn temporary_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let parent = cache_root(app)?;
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let meta = fs::symlink_metadata(&parent).map_err(|error| error.to_string())?;
    if !meta.is_dir() || !crate::update_cache::plain(&meta) { return Err("Недопустимый каталог кэша обновлений".into()); }
    set_private_directory_permissions(&parent)?;
    let mut nonce = [0_u8; 16];
    getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let directory = parent.join(hex::encode(nonce));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    set_private_directory_permissions(&directory)?;
    Ok(directory)
}

fn system_tool(name: &str) -> Result<PathBuf, String> {
    if !cfg!(windows) { return Err("Обновление этого выпуска поддерживается только на Windows".into()); }
    let root = std::env::var_os("SystemRoot").ok_or("Не найден каталог Windows")?;
    let path = PathBuf::from(root).join("System32").join(name);
    if !path.is_absolute() || !path.is_file() { return Err(format!("Не найден системный инструмент: {name}")); }
    Ok(path)
}

fn required_download_space(artifact_bytes: u64) -> Result<u64, String> {
    artifact_bytes.checked_add(DOWNLOAD_HEADROOM)
        .ok_or_else(|| "Некорректный размер скачиваемого обновления".to_string())
}

fn check_download_budget(artifact_bytes: u64, available_bytes: u64) -> Result<(), String> {
    let required = required_download_space(artifact_bytes)?;
    if available_bytes < required {
        let mib = 1024 * 1024;
        let required_mib = required / mib + u64::from(required % mib != 0);
        return Err(format!("Недостаточно места для скачивания обновления: требуется {required_mib} МиБ (установщик и запас 64 МиБ), доступно {} МиБ. Освободите место и повторите скачивание.", available_bytes / mib));
    }
    Ok(())
}

fn download_error(code: Option<i32>) -> String {
    match code {
        Some(23) => "Не удалось записать скачиваемое обновление в кэш (curl 23). Проверьте свободное место на диске и доступ к каталогу кэша, затем повторите скачивание.".into(),
        Some(28) => "Истекло время ожидания скачивания обновления (curl 28). Проверьте соединение с интернетом и повторите скачивание.".into(),
        _ => format!("Не удалось скачать обновление (curl {}). Проверьте соединение с интернетом и повторите скачивание.", code.unwrap_or(-1)),
    }
}

#[cfg(windows)]
fn ensure_download_space(directory: &Path, artifact_bytes: u64) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let mut path: Vec<u16> = directory.as_os_str().encode_wide().collect();
    if path.contains(&0) { return Err("Некорректный путь к кэшу обновлений".into()); }
    if !path.ends_with(&[b'\\' as u16]) { path.push(b'\\' as u16); }
    path.push(0);
    // The caller's available bytes respect disk quotas; total volume free
    // space can overstate what this account is allowed to write.
    let mut available = 0_u64;
    let success = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut())
    };
    if success == 0 {
        return Err(format!("Не удалось проверить свободное место в кэше обновлений {}: {}", directory.display(), std::io::Error::last_os_error()));
    }
    check_download_budget(artifact_bytes, available)
        .map_err(|error| format!("{error} Каталог кэша: {}", directory.display()))
}

#[cfg(not(windows))]
fn ensure_download_space(_directory: &Path, _artifact_bytes: u64) -> Result<(), String> { Ok(()) }

fn fetch(app: &AppHandle, url: &str, destination: &Path, maximum: u64, total: u64) -> Result<(), String> {
    let mut command = windowless_windows_command(system_tool("curl.exe")?.to_str().ok_or("Некорректный системный путь")?);
    command.args(["-q", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "5",
        "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--connect-timeout", "10", "--max-time"])
        .arg(if total == 0 { "25" } else { "900" }).arg("--max-filesize")
        .arg(maximum.to_string()).arg("--output").arg(destination).arg("--url").arg(url)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|e| format!("Не удалось начать скачивание: {e}"))?;
    loop {
        let bytes = fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
        let cancelled = app.state::<UpdateState>().cancel.load(Ordering::SeqCst);
        if cancelled || bytes > maximum {
            let _ = child.kill(); let _ = child.wait(); let _ = fs::remove_file(destination);
            return Err(if cancelled { "Скачивание отменено" } else { "Превышен размер обновления" }.into());
        }
        if total > 0 { progress(app, "downloading", bytes.min(total), total); }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => { let _ = fs::remove_file(destination); return Err(download_error(status.code())); },
            Ok(None) => thread::sleep(Duration::from_millis(120)),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
        }
    }
}

fn read_verified(app: &AppHandle, path: &Path) -> Result<kf_update::VerifiedManifest, String> {
    let config = channel()?;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 {
        return Err("Недопустимый файл описания обновления".into());
    }
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let value = kf_update::parse_and_verify(&raw, &config.public_key_hex, &config.channel, now_ms())
        .map_err(|e| format!("Подпись обновления: {e}"))?;
    let url = Url::parse(&value.manifest.artifact.url).map_err(|e| e.to_string())?;
    if !url.path().to_ascii_lowercase().ends_with(".exe") || value.manifest.artifact.size_bytes > MAX_INSTALLER {
        return Err("В канале должен быть Windows установщик .exe до 512 MiB".into());
    }
    let connection = open_db(app)?;
    let trust: Option<(i64, String)> = connection.query_row(
        "SELECT highest_sequence,manifest_sha256 FROM update_trust_state WHERE channel=?1", params![config.channel],
        |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
    if let Some((sequence, digest)) = trust {
        if value.manifest.sequence < sequence as u64 || (value.manifest.sequence == sequence as u64 && digest != value.manifest_sha256) {
            return Err("Канал предлагает устаревшее или изменённое обновление".into());
        }
    }
    Ok(value)
}

fn verify_installer(directory: &Path, value: &kf_update::VerifiedManifest) -> Result<(), String> {
    let path = directory.join("installer.exe");
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != value.manifest.artifact.size_bytes {
        return Err("Файл установщика был изменён".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0_u8; 2]; file.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"MZ" { return Err("Обновление не является Windows установщиком".into()); }
    file.rewind().map_err(|e| e.to_string())?;
    kf_update::verify_artifact(BufReader::new(file), value).map_err(|e| format!("Проверка установщика: {e}"))
}

#[tauri::command]
pub(crate) fn update_status(app: AppHandle, auth: State<'_, AuthState>, session_token: String) -> Result<UpdateStatus, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    Ok(UpdateStatus { supported: cfg!(windows), current_version: env!("CARGO_PKG_VERSION").into(), installed_sequence: channel()?.installed_sequence })
}

#[tauri::command]
pub(crate) async fn update_check(app: AppHandle, auth: State<'_, AuthState>, session_token: String) -> Result<Option<UpdateInfo>, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let lease = Lease::acquire(&app)?;
    transactional_core::engine_runtime::spawn_blocking(transactional_core::engine_runtime::ExecutionClass::FileIo, move || {
        let _lease = lease;
        let _ = cleanup_cache(&app);
        let directory = temporary_directory(&app)?;
        let result = (|| {
            progress(&app, "checking", 0, 0);
            fetch(&app, &channel()?.endpoint, &directory.join("manifest.json"), 64 * 1024, 0)?;
            let value = read_verified(&app, &directory.join("manifest.json"))?;
            Ok(if value.manifest.sequence > channel()?.installed_sequence { Some(UpdateInfo::from(&value)) } else { None })
        })();
        discard(&app, &directory); result
    }).await.map_err(|e| format!("Проверка обновления: {e}"))?
}

#[tauri::command]
pub(crate) async fn update_install(app: AppHandle, auth: State<'_, AuthState>, session_token: String, manifest_sha256: String) -> Result<UpdateInfo, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let lease = Lease::acquire(&app)?;
    transactional_core::engine_runtime::spawn_blocking(transactional_core::engine_runtime::ExecutionClass::FileIo, move || {
        let _lease = lease;
        if let Some(old) = app.state::<UpdateState>().prepared.lock().map_err(|_| "Updater state")?.take() { discard(&app, &old.directory); }
        let _ = cleanup_cache(&app);
        let directory = temporary_directory(&app)?;
        let result = (|| {
            fetch(&app, &channel()?.endpoint, &directory.join("manifest.json"), 64 * 1024, 0)?;
            let value = read_verified(&app, &directory.join("manifest.json"))?;
            if value.manifest_sha256 != manifest_sha256 || value.manifest.sequence <= channel()?.installed_sequence {
                return Err("Выпуск изменился. Проверьте обновления ещё раз".into());
            }
            ensure_download_space(&directory, value.manifest.artifact.size_bytes)?;
            fetch(&app, &value.manifest.artifact.url, &directory.join("installer.exe"), value.manifest.artifact.size_bytes, value.manifest.artifact.size_bytes)?;
            progress(&app, "verifying", value.manifest.artifact.size_bytes, value.manifest.artifact.size_bytes);
            verify_installer(&directory, &value)?;
            kf_update::accept(&mut open_db(&app)?, &value, now_ms()).map_err(|e| e.to_string())?;
            *app.state::<UpdateState>().prepared.lock().map_err(|_| "Updater state")? = Some(Prepared { directory: directory.clone(), manifest_sha256: value.manifest_sha256.clone() });
            progress(&app, "ready", value.manifest.artifact.size_bytes, value.manifest.artifact.size_bytes);
            Ok(UpdateInfo::from(&value))
        })();
        if result.is_err() { discard(&app, &directory); } result
    }).await.map_err(|e| format!("Скачивание обновления: {e}"))?
}

#[tauri::command]
pub(crate) fn update_cancel(app: AppHandle, auth: State<'_, AuthState>, session_token: String) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    app.state::<UpdateState>().cancel.store(true, Ordering::SeqCst); Ok(())
}

fn idle(snapshots: &[ActorSnapshot]) -> Result<(), String> {
    let now = now_ms();
    for s in snapshots {
        // Cached print_stats survives reconnects. It is evidence of current
        // printing only while connected with recent job telemetry.
        let current_job = s.connected && s.job_updated_at.is_some_and(|at|
            at > 0 && at <= now && now.saturating_sub(at) <= 120_000);
        if current_job && (s.phase == PrinterPhase::Printing
            || matches!(s.cached_status.pointer("/print_stats/state").and_then(|v| v.as_str()), Some("printing" | "paused"))) {
            return Err(format!("Установка отложена: принтер {} сообщает о печати или паузе", s.printer_id));
        }
        // Actual in-process transfers/commands must settle even if the
        // network disappeared. Never mislabel them as an active print.
        if s.active_upload_id.is_some() {
            return Err(format!("Установка отложена: выполняется передача файла на {}", s.printer_id));
        }
        let commands_busy = s.update_blocking_operations
            .map_or(s.active_operation_id.is_some() || s.queued_operations > 0, |count| count > 0);
        if commands_busy {
            return Err(format!("Установка отложена: выполняются команды для {}. Повторите после их завершения", s.printer_id));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_budget_reserves_only_the_installer_and_64_mib() {
        let required = MAX_INSTALLER + 64 * 1024 * 1024;
        assert_eq!(required_download_space(MAX_INSTALLER).unwrap(), required);
        assert!(check_download_budget(MAX_INSTALLER, required).is_ok());
        let error = check_download_budget(MAX_INSTALLER, required - 1).unwrap_err();
        assert!(error.contains("Недостаточно места"));
        assert!(error.contains("требуется 576 МиБ"));
        assert!(error.contains("доступно 575 МиБ"));
    }
    #[test]
    fn download_budget_rounds_required_space_up_and_rejects_overflow() {
        assert!(check_download_budget(1, DOWNLOAD_HEADROOM).unwrap_err().contains("требуется 65 МиБ"));
        assert!(check_download_budget(1, DOWNLOAD_HEADROOM + 1).is_ok());
        assert!(required_download_space(u64::MAX).is_err());
        assert!(check_download_budget(u64::MAX, u64::MAX).is_err());
    }
    #[test]
    fn curl_write_and_timeout_errors_explain_the_actual_failure() {
        let write = download_error(Some(23));
        assert!(write.contains("записать") && write.contains("свободное место"));
        assert!(!write.contains("Канал обновлений недоступен"));
        let timeout = download_error(Some(28));
        assert!(timeout.contains("время ожидания") && timeout.contains("интернетом"));
        for code in [Some(6), Some(22), None] {
            let error = download_error(code);
            assert!(error.contains(&format!("curl {}", code.unwrap_or(-1))));
            assert!(!error.contains("опубликованного выпуска"));
            assert!(!error.contains("Недостаточно места"));
        }
    }
    fn snapshot() -> ActorSnapshot {
        ActorSnapshot { stable_id: "test-cube".into(), printer_id: "test-cube".into(), model_id: None,
            host: "127.0.0.1:7125".into(), active_port: 7125, active_protocol: "rest".into(), session_epoch: 1,
            phase: PrinterPhase::Ready, connected: true, last_eventtime: None, last_seen_at: Some(0),
            telemetry_updated_at: None, nozzle_updated_at: None, bed_updated_at: None,
            job_updated_at: Some(now_ms()), reconnect_attempt: 0, queued_operations: 0, update_blocking_operations: None,
            active_operation_id: None, active_upload_id: None, cached_status: serde_json::json!({}),
            capabilities: Default::default(), identity_attestation: None, last_error: None }
    }
    #[test]
    fn install_is_deferred_for_printing_paused_or_active_transfer() {
        assert!(idle(&[]).is_ok());
        let mut value = snapshot(); assert!(idle(&[value.clone()]).is_ok());
        value.phase = PrinterPhase::Printing; assert!(idle(&[value.clone()]).is_err());
        value.phase = PrinterPhase::Ready; value.cached_status = serde_json::json!({"print_stats":{"state":"paused"}});
        assert!(idle(&[value.clone()]).is_err());
        value.cached_status = serde_json::json!({}); value.active_upload_id = Some("upload".into());
        assert!(idle(&[value.clone()]).is_err());
        value.active_upload_id = None; value.queued_operations = 1; assert!(idle(&[value]).is_err());
    }
    #[test]
    fn disconnected_or_expired_cached_print_does_not_block_update() {
        let mut value = snapshot();
        value.phase = PrinterPhase::Printing;
        value.cached_status = serde_json::json!({"print_stats":{"state":"paused"}});
        value.connected = false;
        assert!(idle(&[value.clone()]).is_ok());
        value.connected = true;
        value.job_updated_at = Some(now_ms() - 120_001);
        assert!(idle(&[value.clone()]).is_ok());
        value.job_updated_at = None;
        assert!(idle(&[value.clone()]).is_ok());
        value.job_updated_at = Some(now_ms());
        assert!(idle(&[value.clone()]).unwrap_err().contains("печати"));
        value.connected = false;
        value.active_upload_id = Some("real-transfer".into());
        assert!(idle(&[value.clone()]).unwrap_err().contains("передача"));
        value.active_upload_id = None;
        value.active_operation_id = Some("pending-command".into());
        let error = idle(&[value]).unwrap_err();
        assert!(error.contains("команды"));
        assert!(!error.contains("печати"));
    }
    #[test]
    fn routine_offline_queries_do_not_block_but_pending_mutations_do() {
        let mut value = snapshot();
        value.connected = false;
        value.active_operation_id = Some("status-query".into());
        value.queued_operations = 4;
        value.update_blocking_operations = Some(0);
        assert!(idle(&[value.clone()]).is_ok());
        value.update_blocking_operations = Some(1);
        assert!(idle(&[value.clone()]).unwrap_err().contains("команды"));
        value.update_blocking_operations = None; // old snapshot fails closed
        assert!(idle(&[value]).is_err());
    }
    #[test]
    fn embedded_channel_is_valid_and_targets_only_our_release_feed() {
        let value = channel().unwrap();
        assert_eq!(value.endpoint, "https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json");
        assert!(value.installed_sequence > 0);
        assert_eq!(value.channel, "stable");
    }
}

#[tauri::command]
pub(crate) async fn update_apply(app: AppHandle, auth: State<'_, AuthState>, core: State<'_, TransactionalCore>, client: State<'_, EngineClient>, session_token: String, manifest_sha256: String) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let lease = Lease::acquire(&app)?;
    let snapshots: Vec<ActorSnapshot> = if client.route_to_daemon().await? {
        client.call_async(transactional_core::engine_runtime::ExecutionClass::ActorIo, kf_ipc::EngineCommand::ActorList, serde_json::Value::Null).await?
    } else { core.initialize(&app)?; core.snapshots() };
    idle(&snapshots)?;
    app.state::<UpdateState>().applying.store(true, Ordering::SeqCst);
    let app_worker = app.clone();
    let result = transactional_core::engine_runtime::spawn_blocking(transactional_core::engine_runtime::ExecutionClass::FileIo, move || {
        let _lease = lease;
        let prepared = app_worker.state::<UpdateState>().prepared.lock().map_err(|_| "Updater state")?.clone().ok_or("Сначала скачайте обновление")?;
        let value = read_verified(&app_worker, &prepared.directory.join("manifest.json"))?;
        if value.manifest_sha256 != manifest_sha256 || prepared.manifest_sha256 != manifest_sha256 { return Err("Проверенное обновление изменилось".into()); }
        verify_installer(&prepared.directory, &value)?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        if executable.file_name().and_then(|n| n.to_str()) != Some("klipper-farm-client.exe") { return Err("Обновление доступно в установленной Windows программе".into()); }
        let ready = prepared.directory.join("helper-ready");
        let mut command = windowless_windows_command(system_tool("WindowsPowerShell/v1.0/powershell.exe")?.to_str().ok_or("Некорректный системный путь")?);
        command.env_remove("PSModulePath");
        command.args(["-NoProfile", "-NonInteractive", "-Command", include_str!("../../scripts/apply-online-update.ps1")])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let payload = serde_json::json!({"parentPid": std::process::id(), "executable": executable, "installer": prepared.directory.join("installer.exe"), "sha256": value.manifest.artifact.sha256, "sizeBytes": value.manifest.artifact.size_bytes, "ready": ready, "cacheRoot": cache_root(&app_worker)?});
        if let Err(e) = child.stdin.take().ok_or("Updater input")?.write_all(payload.to_string().as_bytes()) { let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
        let started = Instant::now();
        while !ready.is_file() {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() || started.elapsed() > Duration::from_secs(15) { let _ = child.kill(); let _ = child.wait(); return Err("Не удалось запустить установщик. Программа остаётся открыта".into()); }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }).await.map_err(|e| format!("Запуск обновления: {e}")).and_then(|value| value);
    if result.is_err() { app.state::<UpdateState>().applying.store(false, Ordering::SeqCst); }
    else { app.exit(0); }
    result
}
