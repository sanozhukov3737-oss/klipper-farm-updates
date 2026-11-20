//! Протокол RPC к Moonraker и резервные пути.
//!
//! Здесь собраны вызовы, ретраи и переключение между WebSocket, JSON-RPC и
//! REST, чтобы основной файл приложения оставался сборкой приложения, а не
//! протоколом. Модуль не знает про Tauri-состояние, кроме двух команд, которые
//! регистрируются в invoke_handler.


use std::time::Duration;

use serde_json::Value;
use tauri::State;

use crate::moonraker_protocol::{
    self, http_request, http_request_bound, moonraker_default_port, parse_target,
    validate_header_value, websocket_rpc_blocking,
};
use crate::transactional_core::engine_runtime::ExecutionClass;
use crate::transactional_core::TransactionalCore;
use crate::{
    authorize_printer_target, bounded_spawn_blocking, engine_client, engine_owner_conflict, parse_role,
    require_role, stored_api_key, AppHandle, AuthState, HttpResponse, HttpTarget, Role,
    MAX_JSON_RESPONSE,
};
use crate::transactional_core;

pub(crate) fn rpc_required_role(method: &str, params: Option<&serde_json::Value>) -> Result<Role, String> {
    match method {
        "server.info"
        | "printer.info"
        | "machine.system_info"
        | "printer.objects.list"
        | "printer.objects.query"
        | "server.files.list" => Ok(Role::Viewer),
        "server.spoolman.proxy" => {
            let request_method = params
                .and_then(|value| value.get("request_method"))
                .and_then(|value| value.as_str());
            let path = params
                .and_then(|value| value.get("path"))
                .and_then(|value| value.as_str());
            if request_method == Some("GET")
                && path.is_some_and(|value| value.starts_with("/v1/spool"))
            {
                Ok(Role::Viewer)
            } else {
                Err("Метод Spoolman заблокирован политикой безопасности".into())
            }
        }
        "printer.print.pause"
        | "printer.print.resume"
        | "printer.print.cancel"
        | "printer.print.start"
        | "printer.emergency_stop"
        | "printer.restart"
        | "printer.firmware_restart"
        | "printer.gcode.script"
        | "server.job_queue.post_job"
        | "server.job_queue.start"
        | "server.job_queue.pause"
        | "server.job_queue.delete_job"
        | "server.spoolman.post_spool_id" => Ok(Role::Operator),
        _ => Err("Метод Moonraker не разрешён политикой безопасности".into()),
    }
}
pub(crate) fn rpc_params_body(params: Option<&serde_json::Value>) -> Result<Vec<u8>, String> {
    let value = params
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if body.len() > 512 * 1024 {
        return Err("Параметры Moonraker слишком велики".into());
    }
    Ok(body)
}
pub(crate) fn rpc_without_params(
    method: &str,
    path: &'static str,
    http_method: &'static str,
    params: Option<&serde_json::Value>,
) -> Result<Option<RestRpcFallback>, String> {
    if params.is_some_and(|value| !value.is_null()) {
        return Err(format!("Метод {method} не принимает параметры"));
    }
    Ok(Some(RestRpcFallback {
        method: http_method,
        path: path.to_string(),
        content_type: None,
        body: Vec::new(),
    }))
}
pub(crate) fn moonraker_query_result_useful(value: &serde_json::Value) -> bool {
    let mut queue = vec![value];
    let mut inspected = 0usize;
    while let Some(current) = queue.pop() {
        inspected += 1;
        if inspected > 16 {
            break;
        }
        let Some(object) = current.as_object() else {
            continue;
        };
        if object
            .get("status")
            .and_then(|status| status.as_object())
            .is_some_and(|status| !status.is_empty())
        {
            return true;
        }
        if object.keys().any(|key| {
            matches!(
                key.as_str(),
                "print_stats"
                    | "virtual_sdcard"
                    | "extruder"
                    | "heater_bed"
                    | "webhooks"
                    | "toolhead"
                    | "configfile"
            )
        }) {
            return true;
        }
        for key in ["result", "data", "response"] {
            if let Some(child) = object.get(key) {
                queue.push(child);
            }
        }
    }
    false
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RestRpcFallback {
    pub(crate) method: &'static str,
    pub(crate) path: String,
    pub(crate) content_type: Option<&'static str>,
    pub(crate) body: Vec<u8>,
}

pub(crate) async fn rpc_async(
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    prefer_rest: bool,
    timeout_ms: Option<u64>,
    default_port: u16,
    cancellation: kf_moonraker::CancellationToken,
) -> Result<serde_json::Value, String> {
    let target = parse_target(&host, default_port)?;
    let deadline = tokio::time::Instant::now() + bounded_rpc_timeout(timeout_ms);
    if prefer_rest {
        let result = execute_rest_rpc_fallback_async(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            deadline,
            true,
            &cancellation,
        )
        .await?
        .ok_or("REST endpoint Moonraker не поддерживает этот метод")?;
        if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
            return Err("REST Moonraker вернул пустой снимок объектов".into());
        }
        return Ok(result);
    }

    let mut request = serde_json::json!({"jsonrpc":"2.0","method":&method,"id":1});
    if let Some(value) = params.as_ref().filter(|value| !value.is_null()) {
        request["params"] = value.clone();
    }
    let body = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    if body.len() > 512 * 1024 {
        return Err("Параметры Moonraker слишком велики".into());
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("OPERATION_DEADLINE_EXCEEDED".into());
    }
    let response = moonraker_protocol::http_request_async(
        &target,
        "POST",
        "/server/jsonrpc",
        api_key.as_deref(),
        Some("application/json"),
        &body,
        MAX_JSON_RESPONSE,
        remaining,
        &cancellation,
    )
    .await?;
    if should_try_rest_fallback(response.status, None)
        || should_try_query_compatibility_fallback(&method, response.status, None)
    {
        if let Some(result) = execute_rest_rpc_fallback_async(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            deadline,
            false,
            &cancellation,
        )
        .await?
        {
            return Ok(result);
        }
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("Moonraker HTTP error: {}", response.status));
    }
    let json: serde_json::Value = serde_json::from_slice(&response.body)
        .map_err(|error| format!("Moonraker JSON error: {error}"))?;
    if let Some(error) = json.get("error") {
        let rpc_error_code = error.get("code").and_then(serde_json::Value::as_i64);
        if should_try_rest_fallback(response.status, rpc_error_code)
            || should_try_query_compatibility_fallback(&method, response.status, rpc_error_code)
        {
            if let Some(result) = execute_rest_rpc_fallback_async(
                &target,
                api_key.as_deref(),
                &method,
                params.as_ref(),
                deadline,
                false,
                &cancellation,
            )
            .await?
            {
                return Ok(result);
            }
        }
        let message: String = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Moonraker RPC error")
            .chars()
            .take(512)
            .collect();
        return Err(format!("MOONRAKER_RPC: {message}"));
    }
    let result = json.get("result").cloned().unwrap_or(json);
    if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
        if let Some(compatible) = execute_rest_rpc_fallback_async(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            deadline,
            false,
            &cancellation,
        )
        .await?
        {
            return Ok(compatible);
        }
    }
    Ok(result)
}
#[cfg(test)]
pub(crate) fn rpc_blocking(
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    prefer_rest: bool,
    timeout_ms: Option<u64>,
    default_port: u16,
) -> Result<serde_json::Value, String> {
    let target = parse_target(&host, default_port)?;
    let timeout = bounded_rpc_timeout(timeout_ms);
    // Selected vendor profiles may opt into the fixed, allowlisted REST route.
    // This mode is deliberately strict: after a REST network timeout we must
    // not start a second full JSON-RPC timeout, otherwise a 3.5 s K1C cycle
    // becomes the 8-9 s UI stall this path is intended to prevent.
    if prefer_rest {
        let result = execute_rest_rpc_fallback(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            timeout,
            true,
        )?
        .ok_or("REST endpoint Moonraker не поддерживает этот метод")?;
        if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
            return Err("REST Moonraker вернул пустой снимок объектов".into());
        }
        return Ok(result);
    }
    let mut request = serde_json::json!({"jsonrpc":"2.0","method":&method,"id":1});
    if let Some(value) = params.as_ref() {
        if !value.is_null() {
            request["params"] = value.clone();
        }
    }
    let body = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if body.len() > 512 * 1024 {
        return Err("Параметры Moonraker слишком велики".into());
    }
    let response = http_request(
        &target,
        "POST",
        "/server/jsonrpc",
        api_key.as_deref(),
        Some("application/json"),
        &body,
        MAX_JSON_RESPONSE,
        timeout,
    )?;
    if should_try_rest_fallback(response.status, None)
        || should_try_query_compatibility_fallback(&method, response.status, None)
    {
        if let Some(result) = execute_rest_rpc_fallback(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            timeout,
            false,
        )? {
            return Ok(result);
        }
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("Moonraker HTTP error: {}", response.status));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&response.body).map_err(|e| format!("Moonraker JSON error: {e}"))?;
    if let Some(error) = json.get("error") {
        let rpc_error_code = error.get("code").and_then(|value| value.as_i64());
        if should_try_rest_fallback(response.status, rpc_error_code)
            || should_try_query_compatibility_fallback(&method, response.status, rpc_error_code)
        {
            if let Some(result) = execute_rest_rpc_fallback(
                &target,
                api_key.as_deref(),
                &method,
                params.as_ref(),
                timeout,
                false,
            )? {
                return Ok(result);
            }
        }
        let message: String = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Moonraker RPC error")
            .chars()
            .take(512)
            .collect();
        return Err(format!("MOONRAKER_RPC: {message}"));
    }
    let result = json.get("result").cloned().unwrap_or(json);
    if method == "printer.objects.query" && !moonraker_query_result_useful(&result) {
        if let Some(compatible) = execute_rest_rpc_fallback(
            &target,
            api_key.as_deref(),
            &method,
            params.as_ref(),
            timeout,
            false,
        )? {
            return Ok(compatible);
        }
    }
    Ok(result)
}
#[cfg(test)]
pub(crate) fn execute_rest_rpc_fallback(
    target: &HttpTarget,
    api_key: Option<&str>,
    method: &str,
    params: Option<&serde_json::Value>,
    timeout: Duration,
    query_get_first: bool,
) -> Result<Option<serde_json::Value>, String> {
    let preferred_query_get = query_get_first && method == "printer.objects.query";
    let fallback = if preferred_query_get {
        Some(objects_query_get_fallback(params)?)
    } else {
        rest_fallback_for_rpc(method, params)?
    };
    let Some(fallback) = fallback else {
        return Ok(None);
    };
    let response = http_request(
        target,
        fallback.method,
        &fallback.path,
        api_key,
        fallback.content_type,
        &fallback.body,
        MAX_JSON_RESPONSE,
        timeout,
    )?;
    // POST is the current Moonraker REST API. Some FlashForge/community forks
    // expose the older query-string GET form only, so retry that exact bounded
    // read request after an explicit endpoint/method miss.
    let mut used_query_get = preferred_query_get;
    let response = if method == "printer.objects.query"
        && used_query_get
        && matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)
    {
        used_query_get = false;
        let alternate = rest_fallback_for_rpc(method, params)?
            .ok_or("REST POST endpoint Moonraker недоступен")?;
        http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?
    } else if method == "printer.objects.query"
        && !used_query_get
        && matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)
    {
        used_query_get = true;
        let alternate = objects_query_get_fallback(params)?;
        http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?
    } else {
        response
    };
    let result = parse_moonraker_result(response)?;
    if method == "printer.objects.query"
        && used_query_get
        && preferred_query_get
        && !moonraker_query_result_useful(&result)
    {
        let alternate = rest_fallback_for_rpc(method, params)?
            .ok_or("REST POST endpoint Moonraker недоступен")?;
        let response = http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?;
        return parse_moonraker_result(response).map(Some);
    }
    if method == "printer.objects.query"
        && !used_query_get
        && !preferred_query_get
        && !moonraker_query_result_useful(&result)
    {
        let alternate = objects_query_get_fallback(params)?;
        let response = http_request(
            target,
            alternate.method,
            &alternate.path,
            api_key,
            alternate.content_type,
            &alternate.body,
            MAX_JSON_RESPONSE,
            timeout,
        )?;
        return parse_moonraker_result(response).map(Some);
    }
    Ok(Some(result))
}
pub(crate) async fn execute_rest_rpc_fallback_async(
    target: &HttpTarget,
    api_key: Option<&str>,
    method: &str,
    params: Option<&serde_json::Value>,
    deadline: tokio::time::Instant,
    query_get_first: bool,
    cancellation: &kf_moonraker::CancellationToken,
) -> Result<Option<serde_json::Value>, String> {
    let preferred_query_get = query_get_first && method == "printer.objects.query";
    let fallback = if preferred_query_get {
        Some(objects_query_get_fallback(params)?)
    } else {
        rest_fallback_for_rpc(method, params)?
    };
    let Some(mut fallback) = fallback else {
        return Ok(None);
    };
    let mut used_query_get = preferred_query_get;
    let mut remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("OPERATION_DEADLINE_EXCEEDED".into());
    }
    let mut response = moonraker_protocol::http_request_async(
        target,
        fallback.method,
        &fallback.path,
        api_key,
        fallback.content_type,
        &fallback.body,
        MAX_JSON_RESPONSE,
        remaining,
        cancellation,
    )
    .await?;
    if method == "printer.objects.query"
        && matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)
    {
        fallback = if used_query_get {
            rest_fallback_for_rpc(method, params)?
                .ok_or("REST POST endpoint Moonraker недоступен")?
        } else {
            objects_query_get_fallback(params)?
        };
        used_query_get = !used_query_get;
        remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("OPERATION_DEADLINE_EXCEEDED".into());
        }
        response = moonraker_protocol::http_request_async(
            target,
            fallback.method,
            &fallback.path,
            api_key,
            fallback.content_type,
            &fallback.body,
            MAX_JSON_RESPONSE,
            remaining,
            cancellation,
        )
        .await?;
    }
    let result = parse_moonraker_result(response)?;
    let compatibility_empty = method == "printer.objects.query"
        && !moonraker_query_result_useful(&result)
        && ((used_query_get && preferred_query_get) || (!used_query_get && !preferred_query_get));
    if compatibility_empty {
        fallback = if used_query_get {
            rest_fallback_for_rpc(method, params)?
                .ok_or("REST POST endpoint Moonraker недоступен")?
        } else {
            objects_query_get_fallback(params)?
        };
        remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("OPERATION_DEADLINE_EXCEEDED".into());
        }
        let response = moonraker_protocol::http_request_async(
            target,
            fallback.method,
            &fallback.path,
            api_key,
            fallback.content_type,
            &fallback.body,
            MAX_JSON_RESPONSE,
            remaining,
            cancellation,
        )
        .await?;
        return parse_moonraker_result(response).map(Some);
    }
    Ok(Some(result))
}
#[tauri::command]
pub(crate) async fn moonraker_rpc(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, engine_client::EngineClient>,
    session_token: String,
    printer_id: Option<String>,
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    prefer_rest: Option<bool>,
    timeout_ms: Option<u64>,
    default_port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let minimum = rpc_required_role(&method, params.as_ref())?;
    let user = require_role(&app, &auth, &session_token, minimum)?;
    let printer_id = printer_id.ok_or("Отсутствует ID принтера")?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if api_key.is_some() && parse_role(&user.role)? < Role::Admin {
        return Err("FORBIDDEN: только администратор может передавать новый API Key".into());
    }
    let key = match api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(value.trim().to_string()),
        None => stored_api_key(Some(&printer_id))?,
    };
    if let Some(value) = key.as_deref() {
        validate_header_value(value, 512)?;
    }
    let default_port = moonraker_default_port(default_port)?;
    let discovery_probe = printer_id.starts_with("scan-");
    if !discovery_probe && client.route_to_daemon().await? {
        let result: transactional_core::types::OperationResult = client
            .call_async(
                ExecutionClass::ActorIo,
                kf_ipc::EngineCommand::ActorRpc,
                serde_json::json!({
                    "printerId":printer_id,
                    "method":method,
                    "params":params,
                    "preferRest":prefer_rest.unwrap_or(false),
                    "timeoutMs":timeout_ms,
                    "expectedSessionEpoch":null,
                    "operationId":null,
                }),
            )
            .await?;
        return Ok(result.result);
    }
    let embedded_ready = match core.initialize(&app) {
        Ok(()) => true,
        Err(error) if engine_owner_conflict(&error) => {
            // A stale or independently managed daemon can still own the
            // process-wide engine lease while its IPC endpoint is unusable.
            // The authenticated, target-authorized direct Moonraker transport
            // does not touch SQLite or actor state, so keep printer telemetry
            // available instead of turning one local IPC fault into a 0/N
            // farm outage.
            crate::observability::record(
                "warn",
                "desktop_startup",
                "MOONRAKER_DIRECT_FAILOVER",
                Some(&printer_id),
                "Engine lease занят без доступного IPC; запрос отправлен напрямую в Moonraker",
                serde_json::json!({"engineError":error,"method":method}),
            );
            false
        }
        Err(error) => return Err(error),
    };
    if embedded_ready && core.snapshot_for_printer(&printer_id).is_some() {
        let core = core.inner().clone();
        return bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
            core.execute_by_printer_id(
                &printer_id,
                method,
                params,
                prefer_rest.unwrap_or(false),
                timeout_ms.unwrap_or(8_000),
                None,
                None,
                None,
                None,
            )?
            .map(|result| result.result)
            .ok_or_else(|| "PrinterActor остановлен во время отправки команды".into())
        })
        .await
        .map_err(|error| format!("PrinterActor RPC worker failed: {error}"))?;
    }
    rpc_async(
        host,
        key,
        method,
        params,
        prefer_rest.unwrap_or(false),
        timeout_ms,
        default_port,
        kf_moonraker::CancellationToken::default(),
    )
    .await
}
#[tauri::command]
pub(crate) async fn moonraker_ws_rpc(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    client: State<'_, engine_client::EngineClient>,
    session_token: String,
    printer_id: Option<String>,
    host: String,
    api_key: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
    default_port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let minimum = rpc_required_role(&method, params.as_ref())?;
    let user = require_role(&app, &auth, &session_token, minimum)?;
    let printer_id = printer_id.ok_or("Отсутствует ID принтера")?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    if api_key.is_some() && parse_role(&user.role)? < Role::Admin {
        return Err("FORBIDDEN: только администратор может передавать новый API Key".into());
    }
    let key = match api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(value.trim().to_string()),
        None => stored_api_key(Some(&printer_id))?,
    };
    if let Some(value) = key.as_deref() {
        validate_header_value(value, 512)?;
    }
    let default_port = moonraker_default_port(default_port)?;
    let discovery_probe = printer_id.starts_with("scan-");
    if !discovery_probe && client.route_to_daemon().await? {
        let result: transactional_core::types::OperationResult = client
            .call_async(
                ExecutionClass::ActorIo,
                kf_ipc::EngineCommand::ActorRpc,
                serde_json::json!({
                    "printerId":printer_id,
                    "method":method,
                    "params":params,
                    "preferRest":false,
                    "timeoutMs":timeout_ms,
                    "expectedSessionEpoch":null,
                    "operationId":null,
                }),
            )
            .await?;
        return Ok(result.result);
    }
    let embedded_ready = match core.initialize(&app) {
        Ok(()) => true,
        Err(error) if engine_owner_conflict(&error) => {
            crate::observability::record(
                "warn",
                "desktop_startup",
                "MOONRAKER_DIRECT_FAILOVER",
                Some(&printer_id),
                "Engine lease занят без доступного IPC; WebSocket-запрос отправлен напрямую в Moonraker",
                serde_json::json!({"engineError":error,"method":method}),
            );
            false
        }
        Err(error) => return Err(error),
    };
    if embedded_ready && core.snapshot_for_printer(&printer_id).is_some() {
        let core = core.inner().clone();
        return bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
            core.execute_by_printer_id(
                &printer_id,
                method,
                params,
                false,
                timeout_ms.unwrap_or(8_000),
                None,
                None,
                None,
                None,
            )?
            .map(|result| result.result)
            .ok_or_else(|| "PrinterActor остановлен во время отправки команды".into())
        })
        .await
        .map_err(|error| format!("PrinterActor WebSocket worker failed: {error}"))?;
    }
    bounded_spawn_blocking(ExecutionClass::ActorIo, move || {
        websocket_rpc_blocking(host, key, method, params, timeout_ms, default_port)
    })
    .await
    .map_err(|error| format!("Moonraker WebSocket worker failed: {error}"))?
}
pub(crate) fn rest_fallback_for_rpc(
    method: &str,
    params: Option<&serde_json::Value>,
) -> Result<Option<RestRpcFallback>, String> {
    let json_post = |path: &'static str| -> Result<Option<RestRpcFallback>, String> {
        Ok(Some(RestRpcFallback {
            method: "POST",
            path: path.to_string(),
            content_type: Some("application/json"),
            body: rpc_params_body(params)?,
        }))
    };
    match method {
        "server.info" => rpc_without_params(method, "/server/info", "GET", params),
        "printer.info" => rpc_without_params(method, "/printer/info", "GET", params),
        "machine.system_info" => rpc_without_params(method, "/machine/system_info", "GET", params),
        "printer.objects.list" => {
            rpc_without_params(method, "/printer/objects/list", "GET", params)
        }
        "printer.objects.query" => json_post("/printer/objects/query"),
        "server.files.list" => Ok(Some(files_list_fallback(params)?)),
        "server.files.move" => Ok(Some(files_move_fallback(params)?)),
        "server.spoolman.proxy" => json_post("/server/spoolman/proxy"),
        "printer.print.pause" => rpc_without_params(method, "/printer/print/pause", "POST", params),
        "printer.print.resume" => {
            rpc_without_params(method, "/printer/print/resume", "POST", params)
        }
        "printer.print.cancel" => {
            rpc_without_params(method, "/printer/print/cancel", "POST", params)
        }
        "printer.print.start" => Ok(Some(print_start_fallback(params)?)),
        "printer.emergency_stop" => {
            rpc_without_params(method, "/printer/emergency_stop", "POST", params)
        }
        "printer.restart" => rpc_without_params(method, "/printer/restart", "POST", params),
        "printer.firmware_restart" => {
            rpc_without_params(method, "/printer/firmware_restart", "POST", params)
        }
        "printer.gcode.script" => json_post("/printer/gcode/script"),
        "server.job_queue.post_job" => json_post("/server/job_queue/job"),
        "server.job_queue.start" => {
            rpc_without_params(method, "/server/job_queue/start", "POST", params)
        }
        "server.job_queue.pause" => {
            rpc_without_params(method, "/server/job_queue/pause", "POST", params)
        }
        "server.job_queue.delete_job" => Ok(Some(queue_delete_fallback(params)?)),
        "server.spoolman.post_spool_id" => json_post("/server/spoolman/spool_id"),
        _ => Ok(None),
    }
}
pub(crate) fn parse_moonraker_result(response: HttpResponse) -> Result<serde_json::Value, String> {
    if !(200..300).contains(&response.status) {
        return Err(format!("Moonraker HTTP error: {}", response.status));
    }
    if response.body.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let json: serde_json::Value =
        serde_json::from_slice(&response.body).map_err(|e| format!("Moonraker JSON error: {e}"))?;
    Ok(json.get("result").cloned().unwrap_or(json))
}
pub(crate) fn should_try_rest_fallback(status: u16, rpc_error_code: Option<i64>) -> bool {
    matches!(status, 404 | 405) || rpc_error_code == Some(-32601)
}
pub(crate) fn should_try_query_compatibility_fallback(
    method: &str,
    status: u16,
    rpc_error_code: Option<i64>,
) -> bool {
    method == "printer.objects.query"
        && (matches!(status, 400 | 415 | 422 | 500 | 501) || rpc_error_code == Some(-32602))
}
pub(crate) fn bounded_rpc_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(8_000).clamp(1_000, 8_000))
}
pub(crate) fn bounded_http_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1_000, 15_000))
}
pub(crate) fn queue_delete_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let params = params
        .and_then(|value| value.as_object())
        .ok_or("Для удаления из очереди нужны параметры")?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if params.get("all").and_then(|value| value.as_bool()) == Some(true) {
        query.append_pair("all", "true");
    } else {
        let job_ids = params
            .get("job_ids")
            .and_then(|value| value.as_array())
            .ok_or("Для удаления из очереди нужны job_ids")?;
        if job_ids.is_empty() || job_ids.len() > 256 {
            return Err("Некорректное количество job_ids".into());
        }
        let mut values = Vec::with_capacity(job_ids.len());
        for value in job_ids {
            let id = value
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
                .ok_or("Некорректный job_id")?;
            values.push(id);
        }
        query.append_pair("job_ids", &values.join(","));
    }
    Ok(RestRpcFallback {
        method: "DELETE",
        path: format!("/server/job_queue/job?{}", query.finish()),
        content_type: None,
        body: Vec::new(),
    })
}
pub(crate) fn files_list_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let mut path = "/server/files/list".to_string();
    if let Some(value) = params.filter(|value| !value.is_null()) {
        let object = value
            .as_object()
            .ok_or("Некорректные параметры списка файлов")?;
        if object.keys().any(|key| key != "root") {
            return Err("Неподдерживаемые параметры списка файлов".into());
        }
        if let Some(root) = object.get("root") {
            let root = root
                .as_str()
                .filter(|root| matches!(*root, "gcodes" | "config"))
                .ok_or("Недопустимый корень списка файлов")?;
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.append_pair("root", root);
            let query = serializer.finish();
            path.push('?');
            path.push_str(&query);
        }
    }
    Ok(RestRpcFallback {
        method: "GET",
        path,
        content_type: None,
        body: Vec::new(),
    })
}
pub(crate) fn files_move_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let object = params
        .and_then(serde_json::Value::as_object)
        .ok_or("Для перемещения нужны source и dest")?;
    if object.keys().any(|key| !matches!(key.as_str(), "source" | "dest")) {
        return Err("Неподдерживаемые параметры перемещения файла".into());
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for field in ["source", "dest"] {
        let value = object.get(field).and_then(serde_json::Value::as_str)
            .filter(|value| {
                !value.is_empty() && value.len() <= 2048
                    && !value.bytes().any(|byte| byte < 0x20 || byte == 0x7f || byte == b'\\')
                    && value.split('/').count() >= 2
                    && matches!(value.split('/').next(), Some("gcodes" | "config"))
                    && !value.split('/').any(|part| part.is_empty() || matches!(part, "." | ".."))
            })
            .ok_or_else(|| format!("Некорректный путь перемещения: {field}"))?;
        query.append_pair(field, value);
    }
    // Query arguments work with stock Moonraker and vendor REST handlers that
    // do not expose /server/jsonrpc or decode JSON bodies for file operations.
    Ok(RestRpcFallback {
        method: "POST",
        path: format!("/server/files/move?{}", query.finish()),
        content_type: None,
        body: Vec::new(),
    })
}
pub(crate) fn objects_query_get_fallback(
    params: Option<&serde_json::Value>,
) -> Result<RestRpcFallback, String> {
    let params = params
        .and_then(|value| value.as_object())
        .ok_or("Для запроса объектов нужны параметры")?;
    if params.keys().any(|key| key != "objects") {
        return Err("Неподдерживаемые параметры запроса объектов".into());
    }
    let objects = params
        .get("objects")
        .and_then(|value| value.as_object())
        .filter(|objects| !objects.is_empty() && objects.len() <= 512)
        .ok_or("Некорректный список объектов Moonraker")?;
    let encode = |value: &str| -> String {
        url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
    };
    let mut parts = Vec::with_capacity(objects.len());
    for (name, fields) in objects {
        if name.is_empty() || name.len() > 160 || name.chars().any(char::is_control) {
            return Err("Некорректное имя объекта Moonraker".into());
        }
        let encoded_name = encode(name);
        if fields.is_null() {
            parts.push(encoded_name);
            continue;
        }
        let fields = fields
            .as_array()
            .filter(|fields| fields.len() <= 64)
            .ok_or("Некорректный список полей объекта Moonraker")?;
        let mut names = Vec::with_capacity(fields.len());
        for field in fields {
            let field = field
                .as_str()
                .filter(|field| {
                    !field.is_empty()
                        && field.len() <= 96
                        && field.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                        })
                })
                .ok_or("Некорректное поле объекта Moonraker")?;
            names.push(field);
        }
        parts.push(format!("{encoded_name}={}", encode(&names.join(","))));
    }
    let path = format!("/printer/objects/query?{}", parts.join("&"));
    if path.len() > 4096 {
        return Err("Запрос объектов Moonraker слишком велик".into());
    }
    Ok(RestRpcFallback {
        method: "GET",
        path,
        content_type: None,
        body: Vec::new(),
    })
}
pub(crate) fn print_start_fallback(params: Option<&serde_json::Value>) -> Result<RestRpcFallback, String> {
    let object = params
        .and_then(|value| value.as_object())
        .ok_or("Для запуска печати требуется имя файла")?;
    if object.keys().any(|key| key != "filename") {
        return Err("Неподдерживаемые параметры запуска печати".into());
    }
    let filename = object
        .get("filename")
        .and_then(|value| value.as_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 2048
                && !value.starts_with('/')
                && !value
                    .bytes()
                    .any(|byte| byte < 0x20 || byte == 0x7f || byte == b'\\')
                && !value
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | ".."))
        })
        .ok_or("Некорректное имя файла печати")?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("filename", filename);
    Ok(RestRpcFallback {
        method: "POST",
        path: format!("/printer/print/start?{}", serializer.finish()),
        content_type: None,
        body: Vec::new(),
    })
}
