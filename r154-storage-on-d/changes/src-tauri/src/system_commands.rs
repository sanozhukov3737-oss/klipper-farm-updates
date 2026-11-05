use super::*;

fn camera_path(host: &str, value: &str) -> Result<String, String> {
    if value.starts_with('/') && !value.starts_with("//") {
        return Ok(value.to_string());
    }
    let configured = parse_target(host, 7125)?;
    let url = Url::parse(value).map_err(|_| "Некорректный URL камеры")?;
    if url.scheme() != "http" || url.query().is_some_and(|query| query.len() > 1024) {
        return Err("Некорректный URL камеры".into());
    }
    let camera_target = parse_target(
        &http_host_url(
            url.host_str().ok_or("URL камеры без IP")?,
            url.port().unwrap_or(80),
        ),
        80,
    )?;
    if camera_target.socket.ip() != configured.socket.ip() {
        return Err("Камера должна находиться на том же IP, что и принтер".into());
    }
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    Ok(path)
}

#[tauri::command]
pub(super) async fn moonraker_snapshot(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    url: String,
) -> Result<NativeHttpResponse, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    let path = camera_path(&host, &url)?;
    let moonraker_target = parse_target(&host, 7125)?;
    let target = if url.starts_with("http://") {
        let parsed = Url::parse(&url).map_err(|_| "Некорректный URL камеры")?;
        parse_target(
            &http_host_url(
                parsed.host_str().ok_or("URL камеры без IP")?,
                parsed.port().unwrap_or(80),
            ),
            80,
        )?
    } else {
        HttpTarget {
            authority: moonraker_target.authority.clone(),
            socket: moonraker_target.socket,
        }
    };
    let key = if target.socket == moonraker_target.socket {
        stored_api_key(Some(&printer_id))?
    } else {
        None
    };
    let scheduler = core.scheduler();
    let scheduler_printer_id = printer_id.clone();
    let response = transactional_core::engine_runtime::spawn_blocking(
        transactional_core::engine_runtime::ExecutionClass::ActorIo,
        move || {
            let mut permit = scheduler.acquire_for_printer(
                &scheduler_printer_id,
                transactional_core::types::OperationPriority::Background,
                Duration::from_secs(15),
            )?;
            let response = http_request(
                &target,
                "GET",
                &path,
                key.as_deref(),
                None,
                &[],
                12 * 1024 * 1024,
                Duration::from_secs(15),
            );
            if response.is_ok() {
                permit.success();
            }
            response
        },
    )
    .await
    .map_err(|e| format!("Camera worker failed: {e}"))??;
    if !(200..300).contains(&response.status)
        || !response
            .content_type
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
            .starts_with("image/")
    {
        return Err("Камера не вернула допустимое изображение".into());
    }
    Ok(NativeHttpResponse {
        status: response.status,
        content_type: response.content_type,
        body: response.body,
    })
}

#[tauri::command]
pub(super) fn snapshot_store(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    content_type: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_secret_id(&printer_id)?;
    if data.is_empty() || data.len() > 12 * 1024 * 1024 {
        return Err("Снимок пуст или превышает 12 MiB".into());
    }
    let extension = snapshot_extension(&content_type, &data)?;
    let id = format!("{}.{}", hex::encode(random_bytes::<24>()?), extension);
    let directory = snapshot_directory(&app)?;
    let path = directory.join(&id);
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    let mut entries: Vec<_> = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .collect();
    entries.sort_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok());
    let remove_count = entries.len().saturating_sub(500);
    for entry in entries.into_iter().take(remove_count) {
        let _ = fs::remove_file(entry.path());
    }
    insert_audit(&app, &user.id, "history.snapshot_saved", &printer_id)?;
    Ok(id)
}

#[tauri::command]
pub(super) fn snapshot_read(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    snapshot_id: String,
) -> Result<NativeHttpResponse, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let (hex_id, extension) = snapshot_id
        .rsplit_once('.')
        .ok_or("Некорректный ID снимка")?;
    if hex_id.len() != 48
        || !hex_id.bytes().all(|value| value.is_ascii_hexdigit())
        || !matches!(extension, "jpg" | "png" | "webp")
    {
        return Err("Некорректный ID снимка".into());
    }
    let data = fs::read(snapshot_directory(&app)?.join(&snapshot_id))
        .map_err(|_| "Снимок не найден".to_string())?;
    if data.len() > 12 * 1024 * 1024 {
        return Err("Снимок повреждён".into());
    }
    let content_type = match extension {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    snapshot_extension(content_type, &data)?;
    Ok(NativeHttpResponse {
        status: 200,
        content_type: Some(content_type.into()),
        body: data,
    })
}

fn creality_webrtc_offer_blocking(host: String, offer: String) -> Result<String, String> {
    if offer.is_empty() || offer.len() > 1024 * 1024 {
        return Err("SDP offer превышает допустимый размер".into());
    }
    let printer = parse_target(&host, 7125)?;
    let target = HttpTarget {
        authority: match printer.socket.ip() {
            IpAddr::V4(ip) => format!("{ip}:8000"),
            IpAddr::V6(ip) => format!("[{ip}]:8000"),
        },
        socket: SocketAddr::new(printer.socket.ip(), 8000),
    };
    let response = http_request(
        &target,
        "POST",
        "/call/webrtc_local",
        None,
        Some("text/plain"),
        offer.as_bytes(),
        2 * 1024 * 1024,
        Duration::from_secs(10),
    )?;
    if !(200..300).contains(&response.status) {
        return Err(format!("K1 camera HTTP error: {}", response.status));
    }
    String::from_utf8(response.body).map_err(|_| "Камера вернула не-UTF-8 ответ".into())
}

#[tauri::command]
pub(super) async fn creality_webrtc_offer(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    host: String,
    offer: String,
) -> Result<String, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    transactional_core::engine_runtime::spawn_blocking(
        transactional_core::engine_runtime::ExecutionClass::ActorIo,
        move || creality_webrtc_offer_blocking(host, offer),
    )
    .await
    .map_err(|e| format!("K1 camera worker failed: {e}"))?
}

#[tauri::command]
pub(super) fn secret_set(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    value: String,
) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    if value.trim().is_empty() {
        return secret_delete(app, auth, session_token, printer_id);
    }
    if printer_id == TELEGRAM_TOKEN_ID {
        validate_telegram_token(value.trim())?;
    } else {
        validate_header_value(value.trim(), 512)?;
    }
    secret_entry(&printer_id)?
        .set_password(value.trim())
        .map_err(|e| e.to_string())
}

fn validate_telegram_token(token: &str) -> Result<(), String> {
    let Some((bot_id, secret)) = token.split_once(':') else {
        return Err("Некорректный токен Telegram-бота".into());
    };
    if token.len() > 256
        || bot_id.len() < 6
        || !bot_id.bytes().all(|value| value.is_ascii_digit())
        || secret.len() < 20
        || !secret
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
    {
        return Err("Некорректный токен Telegram-бота".into());
    }
    Ok(())
}

fn validate_telegram_chat_id(chat_id: &str) -> Result<(), String> {
    let numeric_part = chat_id.strip_prefix('-').unwrap_or(chat_id);
    let numeric = !numeric_part.is_empty()
        && numeric_part
        .bytes()
        .all(|value| value.is_ascii_digit());
    let username = chat_id
        .strip_prefix('@')
        .is_some_and(|value| {
            value.len() >= 5
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        });
    if chat_id.is_empty() || chat_id.len() > 128 || (!numeric && !username) {
        return Err("Некорректный Telegram Chat ID".into());
    }
    Ok(())
}

struct TelegramPayloadGuard(PathBuf);

impl Drop for TelegramPayloadGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn telegram_send_blocking(chat_id: String, text: String) -> Result<bool, String> {
    validate_telegram_chat_id(&chat_id)?;
    if text.is_empty()
        || text.chars().count() > 4_096
        || text
            .chars()
            .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
    {
        return Err("Telegram-сообщение пусто, слишком длинное или содержит управляющие символы".into());
    }
    let token = stored_api_key(Some(TELEGRAM_TOKEN_ID))?
        .ok_or("Укажите токен Telegram-бота")?;
    validate_telegram_token(&token)?;

    let payload_path = crate::storage_paths::subdir_without_app("temp").join(format!(
        "klipper-farm-telegram-{}.json",
        hex::encode(random_bytes::<16>()?)
    ));
    let guard = TelegramPayloadGuard(payload_path.clone());
    let payload = serde_json::to_vec(&serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": true
    }))
    .map_err(|error| error.to_string())?;
    let mut payload_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&payload_path)
        .map_err(|error| format!("Не удалось подготовить Telegram-сообщение: {error}"))?;
    crate::set_private_file_permissions(&payload_path)?;
    payload_file
        .write_all(&payload)
        .and_then(|_| payload_file.sync_all())
        .map_err(|error| format!("Не удалось подготовить Telegram-сообщение: {error}"))?;
    drop(payload_file);

    let payload_path_text = payload_path.to_string_lossy();
    if payload_path_text.chars().any(char::is_control) {
        return Err("Системный временный путь Telegram недопустим".into());
    }
    let safe_payload_path = payload_path_text.replace('\\', "/").replace('"', "\\\"");
    let curl_config = format!(
        "url = \"https://api.telegram.org/bot{token}/sendMessage\"\n\
         request = \"POST\"\n\
         header = \"Content-Type: application/json\"\n\
         data-binary = \"@{safe_payload_path}\"\n\
         connect-timeout = 5\n\
         max-time = 8\n\
         max-filesize = 1048576\n\
         proto = \"=https\"\n\
         silent\n\
         show-error\n"
    );
    let mut command = windowless_windows_command("curl");
    let mut child = command
        .arg("--config")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| "Не удалось запустить системный HTTPS-клиент для Telegram".to_string())?;
    child
        .stdin
        .take()
        .ok_or("Не удалось открыть защищённый канал Telegram")?
        .write_all(curl_config.as_bytes())
        .map_err(|_| "Не удалось настроить защищённый канал Telegram".to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "Системный HTTPS-клиент Telegram завершился с ошибкой".to_string())?;
    drop(guard);
    if output.stdout.len() > 1024 * 1024 {
        return Err("Telegram вернул слишком большой ответ".into());
    }
    let response: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Telegram вернул некорректный ответ".to_string())?;
    if output.status.success() && response.get("ok").and_then(|value| value.as_bool()) == Some(true)
    {
        return Ok(true);
    }
    let description = response
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or("Telegram отклонил сообщение")
        .chars()
        .filter(|value| !value.is_control())
        .take(256)
        .collect::<String>();
    Err(description)
}

#[tauri::command]
pub(super) async fn telegram_send(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    chat_id: String,
    text: String,
) -> Result<bool, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    transactional_core::engine_runtime::spawn_blocking(
        transactional_core::engine_runtime::ExecutionClass::ActorIo,
        move || telegram_send_blocking(chat_id, text),
    )
    .await
    .map_err(|error| format!("Telegram worker failed: {error}"))?
}

#[cfg(test)]
mod telegram_tests {
    use super::*;

    #[test]
    fn telegram_identifiers_are_strictly_validated() {
        assert!(validate_telegram_token(
            "123456:abcdefghijklmnopqrstuvwxyz_ABCDE-12345"
        )
        .is_ok());
        assert!(validate_telegram_token("12345:too-short").is_err());
        assert!(validate_telegram_token("123456:abcdefghijklmnopqrstuvwxyz injected").is_err());
        assert!(validate_telegram_chat_id("-1001234567890").is_ok());
        assert!(validate_telegram_chat_id("@klipper_farm").is_ok());
        assert!(validate_telegram_chat_id("@x\nurl = evil").is_err());
    }
}

#[tauri::command]
pub(super) fn secret_delete(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    let entry = secret_entry(&printer_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(super) fn native_notify(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    title: String,
    body: String,
) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    if title.chars().count() > 128 || body.chars().count() > 1024 {
        return Err("Уведомление слишком длинное".into());
    }
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(super) fn autostart_get(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
) -> Result<bool, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub(super) fn autostart_set(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    enabled: bool,
) -> Result<bool, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OfflineUpdateVerification {
    version: String,
    channel: String,
    sequence: u64,
    artifact_sha256: String,
    size_bytes: u64,
    trust_state_advanced: bool,
}

fn regular_update_file(path: &str, maximum_size: u64) -> Result<(PathBuf, u64), String> {
    if path.is_empty() || path.len() > 4_096 || path.contains('\0') {
        return Err("Некорректный путь update-файла".into());
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Update-файл должен иметь абсолютный путь".into());
    }
    let metadata = fs::symlink_metadata(&requested).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Update-файл должен быть обычным файлом, а не ссылкой".into());
    }
    let size = metadata.len();
    if size == 0 || size > maximum_size {
        return Err("Размер update-файла находится вне допустимого диапазона".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;
    Ok((canonical, size))
}

#[tauri::command]
pub(super) async fn update_verify_offline(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    manifest_path: String,
    artifact_path: String,
    public_key_hex: String,
    channel: String,
) -> Result<OfflineUpdateVerification, String> {
    let user = require_role(&app, &auth, &session_token, Role::Admin)?;
    if public_key_hex.len() != 64
        || !public_key_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !matches!(channel.as_str(), "stable" | "beta")
    {
        return Err("Некорректный публичный Ed25519-ключ или update channel".into());
    }
    let app_for_worker = app.clone();
    let verified = transactional_core::engine_runtime::spawn_blocking(
        transactional_core::engine_runtime::ExecutionClass::FileIo,
        move || -> Result<OfflineUpdateVerification, String> {
            let (manifest_path, _) = regular_update_file(&manifest_path, 64 * 1024)?;
            let (artifact_path, artifact_size) =
                regular_update_file(&artifact_path, 8 * 1024 * 1024 * 1024)?;
            if manifest_path == artifact_path {
                return Err("Manifest и update artifact не могут быть одним файлом".into());
            }
            let raw = fs::read(&manifest_path).map_err(|error| error.to_string())?;
            let verified = kf_update::parse_and_verify(
                &raw,
                &public_key_hex.to_ascii_lowercase(),
                &channel,
                now_ms(),
            )
            .map_err(|error| error.to_string())?;
            if verified.manifest.artifact.size_bytes != artifact_size {
                return Err("Размер artifact не совпадает с подписанным manifest".into());
            }
            let artifact = fs::File::open(&artifact_path).map_err(|error| error.to_string())?;
            kf_update::verify_artifact(BufReader::new(artifact), &verified)
                .map_err(|error| error.to_string())?;
            let mut connection = open_db(&app_for_worker)?;
            let trust_state_advanced = kf_update::accept(&mut connection, &verified, now_ms())
                .map_err(|error| error.to_string())?;
            Ok(OfflineUpdateVerification {
                version: verified.manifest.version.clone(),
                channel: verified.manifest.channel.clone(),
                sequence: verified.manifest.sequence,
                artifact_sha256: verified.manifest.artifact.sha256.clone(),
                size_bytes: verified.manifest.artifact.size_bytes,
                trust_state_advanced,
            })
        },
    )
    .await
    .map_err(|error| format!("Update verification worker failed: {error}"))??;
    insert_audit(
        &app,
        &user.id,
        "update.bundle_verified",
        &format!(
            "{}:{}:{}",
            verified.channel, verified.sequence, verified.artifact_sha256
        ),
    )?;
    Ok(verified)
}

