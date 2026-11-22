//! Загрузка файлов на принтер через Moonraker.
//!
//! Обычная загрузка, почастная и через HTTP. Здесь же проверки, кому и куда
//! разрешено писать: имя файла, адрес принтера, привязка к цели.

use std::fs;
use std::path::PathBuf;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use subtle::ConstantTimeEq;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::moonraker_protocol::{
    http_request, moonraker_default_port, parse_http_response, parse_target, validate_header_value,
};
use crate::permissions::set_private_file_permissions;
use crate::transactional_core;
use crate::transactional_core::engine_runtime::ExecutionClass;
use crate::{
    bounded_http_timeout, bounded_spawn_blocking, insert_audit, open_db, parse_role,
    random_bytes, require_role, stored_api_key, AppUser, AuthState, HttpResponse, HttpTarget,
    NativeHttpResponse, Role, TransactionalCore, UploadBeginResult, UploadFinishResult,
    UploadSession, UploadState, MAX_FILE_RESPONSE, MAX_JSON_RESPONSE, MAX_TRANSFER_SESSIONS, MAX_UPLOAD, MAX_UPLOAD_CHUNK, UPLOAD_SESSION_TTL,
};

pub(crate) fn printer_target_bound(app: &AppHandle, printer_id: &str, host: &str) -> Result<bool, String> {
    let requested = parse_target(host, 7125)?;
    let conn = open_db(app)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM kv WHERE key='printers.config'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return Ok(false) };
    let configs: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "Сохранённая конфигурация принтеров повреждена")?;
    let Some(items) = configs.as_array() else {
        return Ok(false);
    };
    for item in items {
        if item.get("id").and_then(|value| value.as_str()) != Some(printer_id) {
            continue;
        }
        let Some(saved_host) = item.get("host").and_then(|value| value.as_str()) else {
            return Ok(false);
        };
        let saved = parse_target(saved_host, 7125)?;
        return Ok(same_printer_channel(&saved, &requested));
    }
    Ok(false)
}

pub(crate) fn authorize_printer_target(
    app: &AppHandle,
    user: &AppUser,
    printer_id: &str,
    host: &str,
) -> Result<(), String> {
    if printer_target_bound(app, printer_id, host)? {
        return Ok(());
    }
    if parse_role(&user.role)? == Role::Admin {
        parse_target(host, 7125)?;
        return Ok(());
    }
    Err("FORBIDDEN: адрес не совпадает с сохранённым принтером".into())
}

pub(crate) fn endpoint_allowed(method: &str, path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let route = path.split('?').next().unwrap_or(path);
    if lower.contains("%2e")
        || lower.contains("%5c")
        || lower.contains("%00")
        || route
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return false;
    }
    match method {
        "GET" => {
            path.starts_with("/server/temperature_store?")
                || path == "/server/webcams/list"
                || path.starts_with("/server/files/list?")
                || path.starts_with("/server/files/directory?")
                || path.starts_with("/server/history/list?")
                || path.starts_with("/server/history/job?")
                || path.starts_with("/server/files/metadata?")
                || path.starts_with("/server/files/thumbnails?")
                || path.starts_with("/server/files/gcodes/")
                || path == "/server/job_queue/status"
                || path == "/server/spoolman/status"
        }
        "DELETE" => path.starts_with("/server/files/gcodes/"),
        _ => false,
    }
}

#[tauri::command]
pub(crate) async fn moonraker_http(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    method: String,
    path: String,
    timeout_ms: Option<u64>,
    default_port: Option<u16>,
) -> Result<NativeHttpResponse, String> {
    let method = method.to_ascii_uppercase();
    let minimum = if method == "GET" {
        Role::Viewer
    } else {
        Role::Operator
    };
    let user = require_role(&app, &auth, &session_token, minimum)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if !endpoint_allowed(&method, &path) {
        return Err("Endpoint Moonraker не разрешён политикой безопасности".into());
    }
    let target = parse_target(&host, moonraker_default_port(default_port)?)?;
    let key = stored_api_key(Some(&printer_id))?;
    let scheduler = core.scheduler();
    let priority = if method == "DELETE" {
        transactional_core::types::OperationPriority::Control
    } else {
        transactional_core::types::OperationPriority::Background
    };
    let maximum = if path.starts_with("/server/files/gcodes/") {
        MAX_FILE_RESPONSE
    } else {
        MAX_JSON_RESPONSE
    };
    let response = bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
        let mut permit =
            scheduler.acquire_for_printer(&printer_id, priority, Duration::from_secs(15))?;
        let response = http_request(
            &target,
            &method,
            &path,
            key.as_deref(),
            None,
            &[],
            maximum,
            bounded_http_timeout(timeout_ms),
        );
        if response.is_ok() {
            permit.success();
        }
        response
    })
    .await
    .map_err(|e| format!("Moonraker HTTP worker failed: {e}"))??;
    Ok(NativeHttpResponse {
        status: response.status,
        content_type: response.content_type,
        body: response.body,
    })
}

pub(crate) fn safe_upload_name(name: &str) -> Result<String, String> {
    let basename = name.rsplit(['/', '\\']).next().unwrap_or("");
    if basename.is_empty()
        || basename.chars().count() > 180
        || name.chars().any(char::is_control)
        || basename.chars().any(|value| "\"<>:|?*".contains(value))
    {
        return Err("Недопустимое имя файла".into());
    }
    let lower = basename.to_ascii_lowercase();
    if !lower.ends_with(".gcode") && !lower.ends_with(".gco") {
        return Err("Разрешены только файлы .gcode и .gco".into());
    }
    // UTF-8 belongs to the original filename. Reject unsafe quoted multipart
    // names above rather than silently changing the file the user selected.
    Ok(basename.to_string())
}

pub(crate) fn upload_to_moonraker_blocking(
    printer_key: &str,
    target: HttpTarget,
    key: Option<String>,
    filename: String,
    data: Vec<u8>,
    scheduler: &transactional_core::scheduler::FarmScheduler,
) -> Result<String, String> {
    let filename = safe_upload_name(&filename)?;
    if data.is_empty() || data.len() > MAX_UPLOAD {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let boundary = format!("KlipperFarm{}", hex::encode(random_bytes::<16>()?));
    let mut body = Vec::with_capacity(data.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&data);
    body.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n--{boundary}--\r\n"
        )
        .as_bytes(),
    );
    let content_type = format!("multipart/form-data; boundary={boundary}");
    scheduler.acquire_bandwidth_for(
        printer_key,
        data.len(),
        transactional_core::types::OperationPriority::Upload,
        Duration::from_secs(60),
        None,
    )?;
    let mut permit = scheduler.acquire_for_printer(
        printer_key,
        transactional_core::types::OperationPriority::Upload,
        Duration::from_secs(15),
    )?;
    let response = http_request(
        &target,
        "POST",
        "/server/files/upload",
        key.as_deref(),
        Some(&content_type),
        &body,
        MAX_JSON_RESPONSE,
        Duration::from_secs(60),
    );
    if response.is_ok() {
        permit.success();
    }
    let response = response?;
    legacy_upload_response_path(&response, &filename, data.len() as u64)
}

pub(crate) fn upload_verified_file_to_moonraker_blocking(
    printer_key: &str,
    target: HttpTarget,
    key: Option<String>,
    filename: String,
    source: PathBuf,
    expected_sha256: String,
    scheduler: &transactional_core::scheduler::FarmScheduler,
) -> Result<String, String> {
    let filename = safe_upload_name(&filename)?;
    let metadata =
        fs::symlink_metadata(&source).map_err(|_| "Файл не найден в локальной библиотеке")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Передавать можно только обычный G-code файл".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let parent = source
        .parent()
        .ok_or("Не удалось определить папку локального G-code")?;
    let temporary = parent.join(format!(
        ".klipper-farm-verified-upload-{}.tmp",
        hex::encode(random_bytes::<12>()?)
    ));
    let operation = (|| -> Result<String, String> {
        // Copy the validated bytes into a private immutable snapshot first.
        // This preserves the old TOCTOU guarantee without holding a 100 MiB
        // Vec in RAM: the exact snapshot that was hashed is the one uploaded.
        let mut input = fs::OpenOptions::new()
            .read(true)
            .open(&source)
            .map_err(|error| error.to_string())?;
        let mut snapshot = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        set_private_file_permissions(&temporary)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; MAX_UPLOAD_CHUNK];
        loop {
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .ok_or("Размер локального G-code переполнен")?;
            if copied > MAX_UPLOAD as u64 || copied > metadata.len() {
                return Err("Локальный G-code изменился во время проверки".into());
            }
            hasher.update(&buffer[..read]);
            snapshot
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
        }
        if copied != metadata.len() {
            return Err("Локальный G-code изменился во время проверки".into());
        }
        snapshot.sync_all().map_err(|error| error.to_string())?;
        let actual_sha256 = hex::encode(hasher.finalize());
        if !bool::from(
            actual_sha256
                .as_bytes()
                .ct_eq(expected_sha256.to_ascii_lowercase().as_bytes()),
        ) {
            return Err("G-code изменился после проверки. Запустите проверку повторно".into());
        }
        snapshot
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;

        let mut permit = scheduler.acquire_for_printer(
            printer_key,
            transactional_core::types::OperationPriority::Upload,
            Duration::from_secs(15),
        )?;
        let mut session = open_chunked_upload(
            target,
            key,
            filename.clone(),
            copied,
            String::new(),
            String::new(),
        )?;
        loop {
            let read = snapshot
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            scheduler.acquire_bandwidth_for(
                printer_key,
                read,
                transactional_core::types::OperationPriority::Upload,
                Duration::from_secs(60),
                None,
            )?;
            session
                .stream
                .write_all(&buffer[..read])
                .map_err(|error| format!("Moonraker upload write failed: {error}"))?;
            session.received_size += read as u64;
        }
        if session.received_size != session.expected_size {
            return Err("Проверенный G-code передан не полностью".into());
        }
        session
            .stream
            .write_all(&session.suffix)
            .map_err(|error| format!("Moonraker upload finish failed: {error}"))?;
        let response = read_http_response_from_stream(
            &mut session.stream,
            MAX_JSON_RESPONSE,
            Duration::from_secs(120),
        )?;
        let result = legacy_upload_response_path(&response, &filename, copied)?;
        permit.success();
        Ok(result)
    })();
    let _ = fs::remove_file(&temporary);
    operation
}

pub(crate) fn read_http_response_from_stream(
    stream: &mut TcpStream,
    maximum_response: usize,
    timeout: Duration,
) -> Result<HttpResponse, String> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or("Недопустимый сетевой тайм-аут")?;
    let wire_limit = maximum_response.saturating_add(1024 * 1024);
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Moonraker upload response timeout".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| error.to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if raw.len().saturating_add(read) > wire_limit {
                    return Err("HTTP-ответ Moonraker превышает допустимый размер".into());
                }
                raw.extend_from_slice(&buffer[..read]);
                if kf_moonraker::http_framing::response_boundary(&raw, maximum_response)? == kf_moonraker::http_framing::Boundary::Complete { break; }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err("Moonraker upload response timeout".into())
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    parse_http_response(&raw, maximum_response)
}

pub(crate) fn open_chunked_upload(
    target: HttpTarget,
    key: Option<String>,
    filename: String,
    expected_size: u64,
    printer_id: String,
    owner_id: String,
) -> Result<UploadSession, String> {
    let filename = safe_upload_name(&filename)?;
    if expected_size == 0 || expected_size > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    if let Some(value) = key.as_deref() {
        validate_header_value(value, 512)?;
    }
    let boundary = format!("KlipperFarm{}", hex::encode(random_bytes::<16>()?));
    let prefix = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    let suffix = format!(
        "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n--{boundary}--\r\n"
    )
    .into_bytes();
    let body_length = (prefix.len() as u64)
        .checked_add(expected_size)
        .and_then(|value| value.checked_add(suffix.len() as u64))
        .ok_or("Размер загрузки переполнен")?;
    if body_length > (MAX_UPLOAD + 1024 * 1024) as u64 {
        return Err("Тело HTTP-запроса слишком велико".into());
    }

    let mut stream = TcpStream::connect_timeout(&target.socket, Duration::from_secs(3))
        .map_err(|error| format!("Moonraker connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut headers = format!(
        "POST /server/files/upload HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\nContent-Length: {body_length}\r\nContent-Type: multipart/form-data; boundary={boundary}\r\n",
        target.authority
    );
    if let Some(value) = key.as_deref().filter(|value| !value.is_empty()) {
        headers.push_str(&format!("X-Api-Key: {value}\r\n"));
    }
    headers.push_str("\r\n");
    stream
        .write_all(headers.as_bytes())
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&prefix)
        .map_err(|error| error.to_string())?;
    Ok(UploadSession {
        stream,
        suffix,
        expected_size,
        received_size: 0,
        filename,
        printer_id,
        owner_id,
        started: Instant::now(),
        hasher: Sha256::new(),
    })
}

#[tauri::command]
pub(crate) async fn moonraker_upload_begin(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    printer_id: String,
    host: String,
    filename: String,
    file_size: u64,
    default_port: Option<u16>,
) -> Result<UploadBeginResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if file_size == 0 || file_size > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let target = parse_target(&host, moonraker_default_port(default_port)?)?;
    let key = stored_api_key(Some(&printer_id))?;
    let scheduler = core.scheduler();
    let upload_id = hex::encode(random_bytes::<16>()?);
    let sessions = Arc::clone(&uploads.sessions);
    {
        let mut items = sessions
            .lock()
            .map_err(|_| "Состояние загрузок недоступно")?;
        items.retain(|_, session| session.started.elapsed() < UPLOAD_SESSION_TTL);
        if items.len() >= MAX_TRANSFER_SESSIONS {
            return Err("Слишком много одновременных загрузок G-code".into());
        }
    }
    let session = bounded_spawn_blocking(ExecutionClass::FileIo, {
        let owner_id = user.id.clone();
        let printer_id = printer_id.clone();
        move || {
            let mut permit = scheduler.acquire_for_printer(
                &printer_id,
                transactional_core::types::OperationPriority::Upload,
                Duration::from_secs(15),
            )?;
            let session =
                open_chunked_upload(target, key, filename, file_size, printer_id, owner_id);
            if session.is_ok() {
                permit.success();
            }
            session
        }
    })
    .await
    .map_err(|error| format!("Moonraker upload begin worker failed: {error}"))??;
    let mut items = sessions
        .lock()
        .map_err(|_| "Состояние загрузок недоступно")?;
    if items.len() >= MAX_TRANSFER_SESSIONS {
        return Err("Слишком много одновременных загрузок G-code".into());
    }
    if items.contains_key(&upload_id) {
        return Err("Конфликт ID загрузки — повторите операцию".into());
    }
    items.insert(upload_id.clone(), session);
    Ok(UploadBeginResult {
        upload_id,
        chunk_size: MAX_UPLOAD_CHUNK,
    })
}

#[tauri::command]
pub(crate) async fn moonraker_upload_chunk(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    upload_id: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<u64, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_upload_id(&upload_id)?;
    if data.is_empty() || data.len() > MAX_UPLOAD_CHUNK {
        return Err("Некорректный блок G-code".into());
    }
    let scheduler = core.scheduler();
    let sessions = Arc::clone(&uploads.sessions);
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let mut session = {
            let mut items = sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?;
            items
                .remove(&upload_id)
                .ok_or("Сессия загрузки не найдена")?
        };
        if session.owner_id != user.id {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("FORBIDDEN: загрузка принадлежит другому пользователю".into());
        }
        if session.started.elapsed() >= UPLOAD_SESSION_TTL {
            return Err("Сессия загрузки истекла".into());
        }
        if offset != session.received_size
            || session.received_size.saturating_add(data.len() as u64) > session.expected_size
        {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("Нарушен порядок блоков G-code".into());
        }
        if let Err(error) = scheduler.acquire_bandwidth_for(
            &session.printer_id,
            data.len(),
            transactional_core::types::OperationPriority::Upload,
            Duration::from_secs(60),
            None,
        ) {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err(error);
        }
        session
            .stream
            .write_all(&data)
            .map_err(|error| format!("Moonraker upload write failed: {error}"))?;
        session.hasher.update(&data);
        session.received_size += data.len() as u64;
        let received = session.received_size;
        sessions
            .lock()
            .map_err(|_| "Состояние загрузок недоступно")?
            .insert(upload_id, session);
        Ok(received)
    })
    .await
    .map_err(|error| format!("Moonraker upload chunk worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn moonraker_upload_finish(
    app: AppHandle,
    auth: State<'_, AuthState>,
    uploads: State<'_, UploadState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    upload_id: String,
) -> Result<UploadFinishResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    let owner_id = user.id.clone();
    validate_upload_id(&upload_id)?;
    let scheduler = core.scheduler();
    let sessions = Arc::clone(&uploads.sessions);
    let (result, printer_id) = bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let mut session = {
            let mut items = sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?;
            items
                .remove(&upload_id)
                .ok_or("Сессия загрузки не найдена")?
        };
        if session.owner_id != owner_id {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("FORBIDDEN: загрузка принадлежит другому пользователю".into());
        }
        if session.received_size != session.expected_size {
            sessions
                .lock()
                .map_err(|_| "Состояние загрузок недоступно")?
                .insert(upload_id, session);
            return Err("G-code передан не полностью".into());
        }
        let mut permit = match scheduler.acquire_for_printer(
            &session.printer_id,
            transactional_core::types::OperationPriority::Upload,
            Duration::from_secs(15),
        ) {
            Ok(permit) => permit,
            Err(error) => {
                sessions
                    .lock()
                    .map_err(|_| "Состояние загрузок недоступно")?
                    .insert(upload_id, session);
                return Err(error);
            }
        };
        session
            .stream
            .write_all(&session.suffix)
            .map_err(|error| format!("Moonraker upload finish failed: {error}"))?;
        let response = read_http_response_from_stream(
            &mut session.stream,
            MAX_JSON_RESPONSE,
            Duration::from_secs(120),
        )?;
        if !(200..300).contains(&response.status) {
            return Err(format!("Upload HTTP {}", response.status));
        }
        let json: serde_json::Value =
            serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
        let path = json
            .pointer("/result/item/path")
            .and_then(|value| value.as_str())
            .unwrap_or(&session.filename)
            .to_string();
        let result = UploadFinishResult {
            path,
            sha256: hex::encode(session.hasher.finalize()),
        };
        permit.success();
        Ok((result, session.printer_id))
    })
    .await
    .map_err(|error| format!("Moonraker upload finish worker failed: {error}"))??;
    insert_audit(
        &app,
        &user.id,
        "gcode.upload_stream",
        &format!("{} · {}", printer_id, result.path),
    )?;
    Ok(result)
}

pub(crate) fn legacy_upload_response_path(
    response: &HttpResponse,
    filename: &str,
    expected_size: u64,
) -> Result<String, String> {
    if !(200..300).contains(&response.status) {
        return Err(transactional_core::upload::upload_http_error(response.status, &response.body));
    }
    let json: serde_json::Value = serde_json::from_slice(&response.body)
        .map_err(|error| format!("Moonraker upload returned invalid JSON: {error}"))?;
    if json.get("error").is_some_and(|value| !value.is_null()) {
        return Err(transactional_core::upload::upload_http_error(response.status, &response.body));
    }
    let returned_path = json
        .pointer("/result/item/path")
        .or_else(|| json.pointer("/item/path"))
        .and_then(serde_json::Value::as_str)
        .ok_or("Moonraker upload не подтвердил путь файла")?;
    let path = returned_path.strip_prefix("gcodes/").unwrap_or(returned_path);
    if path != filename {
        return Err("Moonraker загрузил файл по неожиданному пути".into());
    }
    if let Some(size) = json.pointer("/result/item/size").or_else(|| json.pointer("/item/size")) {
        if size.as_u64() != Some(expected_size) {
            return Err("Moonraker подтвердил неверный размер файла".into());
        }
    }
    Ok(path.to_string())
}

pub(crate) fn validate_upload_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Недопустимый ID загрузки".into());
    }
    Ok(())
}

pub(crate) fn same_printer_channel(saved: &HttpTarget, requested: &HttpTarget) -> bool {
    if saved.socket == requested.socket {
        return true;
    }
    saved.socket.ip() == requested.socket.ip()
        && matches!(saved.socket.port(), 80 | 7125)
        && matches!(requested.socket.port(), 80 | 7125)
}
