//! Persistent app-owned offline inference. Model results cannot invoke printer operations.
use super::*;
use serde_json::{json, Value};
use std::net::{SocketAddrV4, TcpListener};
use std::process::{Child, Command, Stdio};
use std::sync::{MutexGuard, TryLockError};

const MAX_REQUEST_BYTES: usize = 10 * 1024;
const MAX_RESPONSE_BYTES: usize = 8192;
const MAX_HTTP_HEADERS: usize = 16 * 1024;
const MAX_HTTP_BODY: usize = 64 * 1024;
const MAX_HTTP_BYTES: usize = MAX_HTTP_HEADERS + MAX_HTTP_BODY + 16 * 1024;
const SCHEMA: &str = include_str!("../../scripts/voice-semantic-schema.json");
const SYSTEM: &str = include_str!("../../scripts/voice-understanding-prompt.txt");
const ASSET_PINS: &str = include_str!("../../scripts/voice-understanding-assets.json");
const CORRUPT_MODEL: &str = "Файл модели понимания речи повреждён или не соответствует обновлению. Распакуйте архив обновления заново";
static ACTIVE: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);
static CANCELLED: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());
static WORKER: Mutex<Option<SemanticWorker>> = Mutex::new(None);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static VERIFIED_MODEL: Mutex<Option<ModelFingerprint>> = Mutex::new(None);
const CANCEL_TTL: Duration = Duration::from_secs(30);
const MAX_CANCELLED: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SemanticRequest { text: String, context: Value }
#[derive(Serialize)]
pub(crate) struct SemanticStatus { available: bool }

struct ActiveRequest { id: String, cancelled: Arc<AtomicBool> }
fn valid_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn prune_cancelled(rows: &mut Vec<(String, Instant)>, now: Instant) {
    rows.retain(|(_, at)| now.saturating_duration_since(*at) < CANCEL_TTL);
}
fn remember_cancelled(rows: &mut Vec<(String, Instant)>, id: String, now: Instant) {
    prune_cancelled(rows, now);
    if rows.iter().any(|(previous, _)| previous == &id) { return; }
    if rows.len() >= MAX_CANCELLED { rows.remove(0); }
    rows.push((id, now));
}
fn cancel_request(id: String) -> Result<(), String> {
    if !valid_request_id(&id) { return Err("Некорректный запрос отмены понимания речи".into()); }
    // Same lock order as claim: cancellation cannot fall between tombstone lookup and registration.
    let active = ACTIVE.lock().map_err(|_| "Понимание речи недоступно")?;
    if let Some((current, cancelled)) = active.as_ref() {
        if current == &id { cancelled.store(true, Ordering::Release); return Ok(()); }
    }
    let mut rows = CANCELLED.lock().map_err(|_| "Понимание речи недоступно")?;
    remember_cancelled(&mut rows, id, Instant::now());
    Ok(())
}
impl ActiveRequest {
    fn claim(id: String) -> Result<Self, String> {
        if !valid_request_id(&id) {
            return Err("Некорректный запрос понимания речи".into());
        }
        let mut active = ACTIVE.lock().map_err(|_| "Понимание речи недоступно")?;
        let mut rows = CANCELLED.lock().map_err(|_| "Понимание речи недоступно")?;
        prune_cancelled(&mut rows, Instant::now());
        if let Some(index) = rows.iter().position(|(previous, _)| previous == &id) {
            rows.remove(index);
            return Err("Действие отменено".into());
        }
        if SHUTTING_DOWN.load(Ordering::Acquire) { return Err("Действие отменено".into()); }
        if active.is_some() { return Err("Предыдущая фраза ещё обрабатывается".into()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some((id.clone(), cancelled.clone()));
        Ok(Self { id, cancelled })
    }
}
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &self.id) { *active = None; }
        }
    }
}
fn understanding_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().resource_dir().map(|root| root.join("understanding")).map_err(|_| "Не найден модуль понимания речи".into())
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelFingerprint {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
    expected_sha256: String,
}
fn model_pin() -> Result<(u64, String), String> {
    let pins: Value = serde_json::from_str(ASSET_PINS).map_err(|_| "Повреждены данные проверки модуля понимания речи")?;
    let models: Vec<_> = pins.get("assets").and_then(Value::as_array)
        .ok_or("Нет данных проверки модели понимания речи")?.iter()
        .filter(|asset| asset.get("kind").and_then(Value::as_str) == Some("model")).collect();
    if models.len() != 1 { return Err("Неоднозначные данные проверки модели понимания речи".into()); }
    let bytes = models[0].get("bytes").and_then(Value::as_u64).filter(|bytes| *bytes > 0)
        .ok_or("Некорректный размер модели в данных обновления")?;
    let sha256 = models[0].get("sha256").and_then(Value::as_str)
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .ok_or("Некорректная контрольная сумма модели в данных обновления")?;
    Ok((bytes, sha256.to_string()))
}
fn model_fingerprint(path: &Path, metadata: &fs::Metadata, expected_sha256: &str) -> Result<ModelFingerprint, String> {
    if !metadata.is_file() { return Err(CORRUPT_MODEL.into()); }
    Ok(ModelFingerprint {
        path:path.to_path_buf(), bytes:metadata.len(),
        modified:metadata.modified().map_err(|_| CORRUPT_MODEL)?, expected_sha256:expected_sha256.to_string(),
    })
}
fn verify_model_file(
    path: &Path, expected_bytes: u64, expected_sha256: &str,
    cancelled: &AtomicBool, verified: &Mutex<Option<ModelFingerprint>>,
) -> Result<(), String> {
    let result = (|| -> Result<ModelFingerprint, String> {
        check_cancelled(cancelled)?;
        let canonical = fs::canonicalize(path).map_err(|_| CORRUPT_MODEL)?;
        let mut file = fs::File::open(&canonical).map_err(|_| CORRUPT_MODEL)?;
        let before = model_fingerprint(&canonical, &file.metadata().map_err(|_| CORRUPT_MODEL)?, expected_sha256)?;
        if expected_bytes == 0 || before.bytes != expected_bytes { return Err(CORRUPT_MODEL.into()); }
        if verified.lock().map_err(|_| "Не удалось проверить модель понимания речи")?.as_ref() == Some(&before) {
            check_cancelled(cancelled)?;
            return Ok(before);
        }
        let mut sha256 = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = vec![0; 4 * 1024 * 1024];
        loop {
            check_cancelled(cancelled)?;
            let bytes = file.read(&mut buffer).map_err(|_| CORRUPT_MODEL)?;
            if bytes == 0 { break; }
            total = total.checked_add(bytes as u64).ok_or(CORRUPT_MODEL)?;
            if total > expected_bytes { return Err(CORRUPT_MODEL.into()); }
            sha256.update(&buffer[..bytes]);
        }
        check_cancelled(cancelled)?;
        let after = model_fingerprint(&canonical, &file.metadata().map_err(|_| CORRUPT_MODEL)?, expected_sha256)?;
        let current_path = fs::canonicalize(path).map_err(|_| CORRUPT_MODEL)?;
        let current = model_fingerprint(&current_path, &fs::metadata(&current_path).map_err(|_| CORRUPT_MODEL)?, expected_sha256)?;
        if total != expected_bytes || before != after || before != current || hex::encode(sha256.finalize()) != expected_sha256 {
            return Err(CORRUPT_MODEL.into());
        }
        Ok(after)
    })();
    match result {
        Ok(fingerprint) => {
            *verified.lock().map_err(|_| "Не удалось сохранить проверку модели понимания речи")? = Some(fingerprint);
            Ok(())
        }
        Err(error) => {
            if let Ok(mut verified) = verified.lock() { *verified = None; }
            Err(error)
        }
    }
}
fn verify_model(path: &Path, cancelled: &AtomicBool) -> Result<(), String> {
    let (bytes, sha256) = model_pin()?;
    verify_model_file(path, bytes, &sha256, cancelled, &VERIFIED_MODEL)
}
fn executable(root: &Path) -> PathBuf {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")
        && std::is_x86_feature_detected!("f16c") && std::is_x86_feature_detected!("bmi2") {
        let optimized = root.join("runtime").join(if cfg!(windows) { "llama-server-avx2.exe" } else { "llama-server-avx2" });
        if optimized.is_file() { return optimized; }
    }
    root.join("runtime").join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" })
}
#[tauri::command]
pub(crate) fn voice_semantic_status(app: AppHandle, auth: State<'_, AuthState>, session_token: String) -> Result<SemanticStatus, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = understanding_root(&app)?;
    Ok(SemanticStatus { available: executable(&root).is_file() && root.join("model.gguf").is_file() })
}
#[tauri::command]
pub(crate) fn voice_semantic_cancel(app: AppHandle, auth: State<'_, AuthState>, session_token: String, request_id: String) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    cancel_request(request_id)
}
/// Background preparation supplies only the shared system prefix, never user text.
#[tauri::command]
pub(crate) async fn voice_semantic_prepare(app: AppHandle, auth: State<'_, AuthState>, session_token: String) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = understanding_root(&app)?;
    bounded_spawn_blocking(ExecutionClass::FileIo, move || prepare_worker(&root))
        .await.map_err(|_| "Не удалось подготовить понимание речи")?
}
fn prepare_worker(root: &Path) -> Result<(), String> {
    let cancelled = AtomicBool::new(false);
    // A background preparation may already own this lock. Its readiness result
    // must be observed before a caller can treat successful preparation as ready.
    let mut worker = worker_lock(&cancelled)?;
    ensure_worker(&mut worker, root, &cancelled)
}
#[tauri::command]
pub(crate) async fn voice_semantic_interpret(
    app: AppHandle, auth: State<'_, AuthState>, session_token: String,
    request_id: String, request: SemanticRequest,
) -> Result<Value, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = understanding_root(&app)?;
    let (prompt, schema) = prepare_request(&request)?;
    // Claim before scheduling so cancellation while waiting for a worker is observed.
    let active = ActiveRequest::claim(request_id)?;
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let result = infer(&root, &prompt, &schema, &active.cancelled);
        drop(active);
        result
    }).await.map_err(|_| "Не удалось обработать смысл фразы")?
}
/// Root desktop must call this from ExitRequested/Exit, before engine shutdown.
pub(crate) fn shutdown() {
    SHUTTING_DOWN.store(true, Ordering::Release);
    if let Ok(active) = ACTIVE.lock() {
        if let Some((_, cancelled)) = active.as_ref() { cancelled.store(true, Ordering::Release); }
    }
    if let Ok(mut worker) = WORKER.lock() { *worker = None; }
}
fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) || SHUTTING_DOWN.load(Ordering::Acquire) {
        Err("Действие отменено".into())
    } else { Ok(()) }
}
fn prompt_prefix() -> String {
    format!("<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n")
}
// Explicit ordering is independent of serde_json's globally unified preserve_order feature.
fn canonical(value: Value) -> Value {
    match value {
        Value::Object(values) => {
            let mut values: Vec<_> = values.into_iter().collect();
            values.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(values.into_iter().map(|(key, value)| (key, canonical(value))).collect())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}
// The sampler sees schema property order. Keep the discriminator first without
// changing serde_json features used elsewhere by signing and update contracts.
fn schema_json(schema: &Value) -> Result<String, String> {
    fn priority(key: &str) -> usize {
        match key { "kind" => 0, "action" => 1, "mode" => 2, "filter" => 3, "query" => 4, "quantity" => 5, "choice" => 6, "reason" => 7, "minutes" => 8, _ => 9 }
    }
    fn encode(value: &Value, properties: bool, output: &mut String) -> Result<(), String> {
        match value {
            Value::Object(values) => {
                let mut keys: Vec<_> = values.keys().collect();
                keys.sort_by(|left, right| {
                    if properties { priority(left).cmp(&priority(right)).then_with(|| left.cmp(right)) }
                    else { left.cmp(right) }
                });
                output.push('{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 { output.push(','); }
                    output.push_str(&serde_json::to_string(key).map_err(|_| "Не удалось подготовить схему понимания речи")?);
                    output.push(':');
                    let value = values.get(key.as_str()).ok_or("Не удалось прочитать поле схемы понимания речи")?;
                    encode(value, key == "properties", output)?;
                }
                output.push('}');
            }
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 { output.push(','); }
                    encode(value, false, output)?;
                }
                output.push(']');
            }
            value => output.push_str(&serde_json::to_string(value).map_err(|_| "Не удалось подготовить схему понимания речи")?),
        }
        Ok(())
    }
    let mut output = String::new();
    encode(schema, false, &mut output)?;
    Ok(output)
}
fn completion_payload(prompt: &str, schema: Option<&Value>, tokens: u16) -> Result<Vec<u8>, String> {
    let payload = canonical(json!({"prompt":prompt,"n_predict":tokens,"temperature":0,"seed":0,"cache_prompt":true,"stream":false,"response_fields":["content","truncated","stopped_limit"]}));
    let mut payload = serde_json::to_string(&payload).map_err(|_| "Не удалось подготовить фразу для понимания")?;
    if let Some(schema) = schema {
        // Insert schema as raw, correctly ordered JSON. Serializing it as Value
        // would sort properties alphabetically and lose the leading kind field.
        payload.pop();
        payload.push_str(",\"json_schema\":");
        payload.push_str(&schema_json(schema)?);
        payload.push('}');
    }
    Ok(payload.into_bytes())
}
fn prepare_request(request: &SemanticRequest) -> Result<(String, Value), String> {
    if request.text.trim().is_empty() || request.text.chars().count() > 300
        || request.text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') || !request.context.is_object() {
        return Err("Некорректная фраза помощницы".into());
    }
    let serialized = serde_json::to_string(&canonical(json!({"text":request.text,"context":request.context}))).map_err(|_| "Не удалось прочитать фразу")?;
    if serialized.len() > MAX_REQUEST_BYTES { return Err("Слишком много данных в запросе помощницы".into()); }
    let data = serialized.replace('<', "\\u003c").replace('>', "\\u003e");
    let prompt = format!("{}{}<|im_end|>\n<|im_start|>assistant\n", prompt_prefix(), data);
    let mut schema: Value = serde_json::from_str(SCHEMA).map_err(|_| "Повреждена схема понимания речи")?;
    let printers = request.context.get("printers").and_then(Value::as_array).ok_or("Нет списка принтеров в запросе")?;
    if printers.len() > 32 { return Err("Слишком много принтеров в запросе".into()); }
    let mut ids = Vec::new();
    for printer in printers {
        let id = printer.get("id").and_then(Value::as_str).ok_or("Некорректный принтер")?;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) { return Err("Некорректный идентификатор принтера".into()); }
        if !ids.contains(&id) { ids.push(id); }
    }
    let awaiting = request.context.get("awaiting").and_then(Value::as_str);
    let has_file = request.context.get("selectedFile").is_some_and(Value::is_object)
        || request.context.pointer("/request/query").and_then(Value::as_str).is_some_and(|q| !q.trim().is_empty());
    let has_previous_printer = request.context.get("selectedPrinterId").and_then(Value::as_str).is_some_and(|id| ids.contains(&id));
    let has_followup = request.context.get("request").is_some_and(Value::is_object)
        || request.context.get("selectedFile").is_some_and(Value::is_object) || awaiting.is_some();
    let choice_key = match awaiting { Some("printer") => Some("printerChoices"), Some("choice") => Some("fileChoices"), _ => None };
    let choices: Vec<u64> = choice_key.and_then(|key| request.context.get(key)).and_then(Value::as_array)
        .map(|values| values.iter().filter_map(|v| v.get("number").and_then(Value::as_u64)).filter(|n| (1..=40).contains(n)).collect()).unwrap_or_default();
    if let Some(variants) = schema.get_mut("anyOf").and_then(Value::as_array_mut) {
        variants.retain(|variant| match variant.pointer("/properties/kind/const").and_then(Value::as_str) {
            Some("followup") => has_followup, Some("choose") => !choices.is_empty(), _ => true,
        });
        for variant in variants {
            if let Some(properties) = variant.get_mut("properties").and_then(Value::as_object_mut) {
                if properties.contains_key("printerId") {
                    if ids.is_empty() { properties.remove("printerId"); } else { properties.insert("printerId".into(), json!({"enum":ids})); }
                }
                if !has_file { properties.remove("usePreviousFile"); }
                if !has_previous_printer { properties.remove("usePreviousPrinter"); properties.remove("otherPrinter"); }
                if !matches!(awaiting, Some("file" | "choice")) { properties.remove("correctPreviousQuery"); }
                if properties.contains_key("choice") { properties.insert("choice".into(), json!({"enum":choices})); }
            }
        }
    }
    Ok((prompt, canonical(schema)))
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
struct SemanticWorker {
    root: PathBuf, child: Process, port: u16, key: String,
    #[cfg(windows)]
    _job: desktop_job::DesktopJob,
}
impl SemanticWorker {
    fn start(root: &Path, cancelled: &AtomicBool) -> Result<Self, String> {
        check_cancelled(cancelled)?;
        let model = root.join("model.gguf");
        if !model.is_file() || !executable(root).is_file() {
            return Err("В этой установке нет модуля понимания свободной речи. Установите полную новую сборку".into());
        }
        // The GGUF sidecar is outside the compiled installer; verify it before loading.
        verify_model(&model, cancelled)?;
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|_| "Не удалось подготовить локальное понимание речи")?;
        let port = listener.local_addr().map_err(|_| "Не найден локальный канал понимания речи")?.port();
        let mut random = [0; 32];
        getrandom(&mut random).map_err(|_| "Не удалось подготовить локальную авторизацию понимания речи")?;
        let key = hex::encode(random);
        let threads = thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4)).to_string();
        let mut command = Command::new(executable(root));
        // Keep model argv ASCII: CreateProcess/current_dir handle the Unicode install
        // directory, without relying on a C runtime's narrow-argv code page.
        command.current_dir(root.join("runtime")).env_clear().arg("--model").arg(Path::new("..").join("model.gguf"))
            .args(["--offline", "--host", "127.0.0.1", "--parallel", "1", "--ctx-size", "4096", "--n-gpu-layers", "0", "--no-webui", "--no-agent"])
            .arg("--port").arg(port.to_string()).arg("--api-key").arg(&key)
            .arg("--threads").arg(&threads).arg("--threads-batch").arg(&threads)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // Avoid inherited LLAMA_ARG_* settings, model sources, agent tools and proxies.
        #[cfg(windows)]
        {
            for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
                if let Some(value) = std::env::var_os(name) { command.env(name, value); }
            }
            command.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(windows))]
        command.env("LANG", "C.UTF-8");
        drop(listener);
        let child = Process(command.spawn().map_err(|_| "Не удалось запустить локальное понимание речи")?);
        #[cfg(windows)]
        let job = {
            let job = desktop_job::DesktopJob::new().map_err(|_| "Не удалось ограничить процесс понимания речи")?;
            job.attach(&child.0).map_err(|_| "Не удалось привязать процесс понимания речи к приложению")?;
            job
        };
        let mut worker = Self { root:root.to_path_buf(), child, port, key, #[cfg(windows)] _job:job };
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            check_cancelled(cancelled)?;
            if !matches!(worker.child.0.try_wait(), Ok(None)) { return Err("Модуль понимания речи завершился при подготовке".into()); }
            if Instant::now() >= deadline { return Err("Модуль понимания речи не успел подготовиться".into()); }
            if let Ok(response) = worker.http("GET", "/health", &[], cancelled, Instant::now() + Duration::from_millis(500)) {
                if response.status == 200 { break; }
            }
            thread::sleep(Duration::from_millis(50));
        }
        // Shared prefix is evaluated once without user text or previous turns.
        worker.complete(&prompt_prefix(), None, 0, cancelled)?;
        Ok(worker)
    }
    fn reusable(&mut self, root: &Path) -> bool { self.root == root && matches!(self.child.0.try_wait(), Ok(None)) }
    fn complete(&self, prompt: &str, schema: Option<&Value>, tokens: u16, cancelled: &AtomicBool) -> Result<String, String> {
        let body = completion_payload(prompt, schema, tokens)?;
        // CPU-only inference on a 4-core runner can exceed 45s for a 192-token
        // schema-constrained parse; keep the user-facing deadline generous.
        let response = self.http("POST", "/completion", &body, cancelled, Instant::now() + Duration::from_secs(120))?;
        if response.status != 200 { return Err("Локальный модуль не смог разобрать фразу".into()); }
        let result: Value = serde_json::from_slice(&response.body).map_err(|_| "Повреждён ответ локального понимания речи")?;
        if result.get("truncated").and_then(Value::as_bool) == Some(true)
            || tokens > 0 && result.get("stopped_limit").and_then(Value::as_bool) == Some(true) {
            return Err("Фраза слишком длинная для уверенного понимания. Уточните задачу".into());
        }
        let content = result.get("content").and_then(Value::as_str).ok_or("Модуль понимания речи не вернул ответ")?;
        if content.len() > MAX_RESPONSE_BYTES { return Err("Ответ понимания речи превысил ограничение".into()); }
        Ok(content.to_string())
    }
    fn http(&self, method: &str, path: &str, body: &[u8], cancelled: &AtomicBool, deadline: Instant) -> Result<HttpResponse, String> {
        check_cancelled(cancelled)?;
        if body.len() > MAX_HTTP_BODY || !matches!((method, path), ("GET", "/health") | ("POST", "/completion")) {
            return Err("Некорректный локальный запрос понимания речи".into());
        }
        let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300)).map_err(|_| "Нет локального соединения с пониманием речи")?;
        stream.set_read_timeout(Some(Duration::from_millis(100))).map_err(|_| "Не удалось ограничить локальное соединение")?;
        stream.set_write_timeout(Some(Duration::from_secs(1))).map_err(|_| "Не удалось ограничить локальную передачу")?;
        let header = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", self.port, self.key, body.len());
        stream.write_all(header.as_bytes()).and_then(|()| stream.write_all(body)).map_err(|_| "Локальный модуль не принял фразу")?;
        let mut bytes = Vec::new(); let mut buffer = [0; 4096];
        loop {
            check_cancelled(cancelled)?;
            if Instant::now() >= deadline { return Err("Не удалось разобрать фразу за отведённое время. Уточните задачу".into()); }
            match stream.read(&mut buffer) {
                Ok(0) => return parse_http_response(&bytes),
                Ok(size) => {
                    if bytes.len() + size > MAX_HTTP_BYTES { return Err("Локальный ответ превысил ограничение".into()); }
                    bytes.extend_from_slice(&buffer[..size]);
                    if let Some(end) = header_end(&bytes) {
                        if end > MAX_HTTP_HEADERS { return Err("Локальные заголовки превысили ограничение".into()); }
                        if let Ok(response) = parse_http_response(&bytes) { return Ok(response); }
                    } else if bytes.len() > MAX_HTTP_HEADERS { return Err("Локальные заголовки превысили ограничение".into()); }
                }
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => return Err("Локальное соединение понимания речи прервано".into()),
            }
        }
    }
}
fn worker_lock(cancelled: &AtomicBool) -> Result<MutexGuard<'static, Option<SemanticWorker>>, String> {
    loop {
        check_cancelled(cancelled)?;
        match WORKER.try_lock() {
            Ok(worker) => return Ok(worker),
            Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(40)),
            Err(TryLockError::Poisoned(_)) => return Err("Понимание речи недоступно".into()),
        }
    }
}
fn ensure_worker(worker: &mut Option<SemanticWorker>, root: &Path, cancelled: &AtomicBool) -> Result<(), String> {
    check_cancelled(cancelled)?;
    if !worker.as_mut().is_some_and(|worker| worker.reusable(root)) {
        *worker = None;
        *worker = Some(SemanticWorker::start(root, cancelled)?);
    }
    Ok(())
}
fn infer(root: &Path, prompt: &str, schema: &Value, cancelled: &AtomicBool) -> Result<Value, String> {
    let mut worker = worker_lock(cancelled)?;
    ensure_worker(&mut worker, root, cancelled)?;
    let result = worker.as_ref().ok_or("Понимание речи не подготовлено")?.complete(prompt, Some(schema), 192, cancelled);
    if result.is_err() { *worker = None; } // Reap a cancelled/timed-out process and its KV cache.
    let output = result?;
    check_cancelled(cancelled)?;
    parse_output(output.as_bytes())
}
struct HttpResponse { status: u16, body: Vec<u8> }
fn header_end(bytes: &[u8]) -> Option<usize> { bytes.windows(4).position(|v| v == b"\r\n\r\n").map(|offset| offset + 4) }
/// One fixed loopback service: no caller URLs, redirects, compression or ambiguous framing.
fn parse_http_response(bytes: &[u8]) -> Result<HttpResponse, String> {
    if bytes.len() > MAX_HTTP_BYTES { return Err("Локальный ответ превысил ограничение".into()); }
    let end = header_end(bytes).ok_or("Неполные локальные заголовки")?;
    if end > MAX_HTTP_HEADERS { return Err("Локальные заголовки превысили ограничение".into()); }
    let header = std::str::from_utf8(&bytes[..end - 4]).map_err(|_| "Некорректные локальные заголовки")?;
    let mut lines = header.split("\r\n");
    let mut status = lines.next().ok_or("Нет локального статуса")?.splitn(3, ' ');
    if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) { return Err("Неизвестный локальный протокол".into()); }
    let code = status.next().ok_or("Нет локального кода")?;
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) { return Err("Некорректный локальный код".into()); }
    let status = code.parse::<u16>().map_err(|_| "Некорректный локальный код")?;
    let mut length = None; let mut chunked = false;
    for line in lines {
        let (key, value) = line.split_once(':').ok_or("Некорректный локальный заголовок")?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("Некорректное имя локального заголовка".into()); }
        let value = value.trim();
        if value.bytes().any(|b| b.is_ascii_control() && b != b'\t') { return Err("Некорректное значение локального заголовка".into()); }
        if key.eq_ignore_ascii_case("content-length") {
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) { return Err("Некорректная длина локального ответа".into()); }
            let parsed = value.parse::<usize>().map_err(|_| "Некорректная длина локального ответа")?;
            if parsed > MAX_HTTP_BODY { return Err("Локальное тело ответа превысило ограничение".into()); }
            length = Some(parsed);
        } else if key.eq_ignore_ascii_case("transfer-encoding") {
            if chunked || !value.eq_ignore_ascii_case("chunked") { return Err("Неизвестное локальное кодирование".into()); }
            chunked = true;
        } else if key.eq_ignore_ascii_case("content-encoding") && !value.eq_ignore_ascii_case("identity") {
            return Err("Сжатие локального ответа не поддерживается".into());
        }
    }
    let raw = &bytes[end..];
    let body = if chunked {
        if length.is_some() { return Err("Противоречивое локальное кодирование".into()); }
        decode_chunks(raw)?
    } else {
        let length = length.ok_or("Не указана длина локального ответа")?;
        if raw.len() != length { return Err("Неполное локальное тело ответа".into()); }
        raw.to_vec()
    };
    Ok(HttpResponse { status, body })
}
fn decode_chunks(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new(); let mut offset = 0;
    loop {
        let end = bytes[offset..].windows(2).position(|v| v == b"\r\n").ok_or("Неполный локальный фрагмент")?;
        if end == 0 || end > 16 { return Err("Некорректный размер локального фрагмента".into()); }
        let number = std::str::from_utf8(&bytes[offset..offset + end]).map_err(|_| "Некорректный локальный фрагмент")?;
        if !number.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Некорректный размер локального фрагмента".into()); }
        let size = usize::from_str_radix(number, 16).map_err(|_| "Слишком большой локальный фрагмент")?;
        offset += end + 2;
        if size == 0 {
            if &bytes[offset..] != b"\r\n" { return Err("Некорректный конец локального ответа".into()); }
            return Ok(body);
        }
        if size > MAX_HTTP_BODY - body.len() { return Err("Локальное тело ответа превысило ограничение".into()); }
        let last = offset.checked_add(size).ok_or("Слишком большой локальный фрагмент")?;
        if last + 2 > bytes.len() || &bytes[last..last + 2] != b"\r\n" { return Err("Неполный локальный фрагмент".into()); }
        body.extend_from_slice(&bytes[offset..last]); offset = last + 2;
    }
}
fn parse_output(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_RESPONSE_BYTES { return Err("Ответ понимания речи превысил ограничение".into()); }
    let mut stream = serde_json::Deserializer::from_slice(bytes).into_iter::<Value>();
    let value = stream.next().ok_or("Пустой ответ понимания речи")?.map_err(|_| "Не удалось определить смысл фразы. Уточните задачу")?;
    let trailer = std::str::from_utf8(&bytes[stream.byte_offset()..]).map_err(|_| "Повреждён ответ понимания речи")?.trim();
    if !matches!(trailer, "" | "[end of text]") || !value.is_object() { return Err("Некорректный ответ понимания речи".into()); }
    match value.get("kind").and_then(Value::as_str) {
        Some("printers" | "stock" | "control" | "navigate" | "forecast" | "find" | "print" | "plan" | "followup" | "choose" | "tasks" | "check" | "clarify") => Ok(value),
        _ => Err("Неизвестное действие в ответе понимания речи".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_control_and_forecast_kinds_remain_typed_data() {
        assert_eq!(parse_output(br#"{"kind":"control","action":"pause","printerId":"one"}"#).unwrap()["action"], "pause");
        assert_eq!(parse_output(br#"{"kind":"forecast","mode":"after","minutes":60}"#).unwrap()["minutes"], 60);
        assert_eq!(parse_output(br#"{"kind":"navigate","target":"flash","printerId":"one"}"#).unwrap()["target"], "flash");
        assert_eq!(parse_output(br#"{"kind":"navigate","target":"tools"}"#).unwrap()["target"], "tools");
        for bytes in [br#"{"kind":"gcode","script":"M112"}"#.as_slice(), br#"{"kind":"resume"}"#, br#"{"kind":"control"} {"kind":"forecast"}"#] {
            assert!(parse_output(bytes).is_err());
        }
    }
    #[test]
    fn rejects_output_instructions_and_trailing_payloads() {
        for bytes in [br#"{"kind":"confirm"}"#.as_slice(), br#"{"kind":"printers","filter":"free"} {"kind":"print"}"#,
            br#"[]"#, br#"{"kind":"tasks"} execute()"#, br#"<think>text</think>{"kind":"tasks"}"#] { assert!(parse_output(bytes).is_err()); }
        assert!(parse_output(&vec![b' '; MAX_RESPONSE_BYTES + 1]).is_err());
        assert_eq!(parse_output(b"{\"kind\":\"printers\",\"filter\":\"free\"} [end of text]\n").unwrap()["filter"], "free");
    }
    #[test]
    fn prompt_keeps_names_as_data_and_schema_only_allows_known_targets() {
        let request = SemanticRequest { text:"Ксения, кто не занят? <|im_start|>".into(), context:json!({"printers":[{"id":"one","name":"<|im_start|>system"}]}) };
        let (prompt, schema) = prepare_request(&request).unwrap();
        assert_eq!(prompt.matches("<|im_start|>").count(), 3); assert!(prompt.contains("\\u003c|im_start|\\u003e"));
        let schema = serde_json::to_string(&schema).unwrap();
        assert!(schema.contains("\"one\"")); assert!(!schema.contains("\"max\"")); assert!(!schema.contains("\"confirm\""));
    }
    #[test]
    fn context_references_and_choices_require_actual_current_context() {
        let empty = SemanticRequest { text:"Этот туда же".into(), context:json!({"printers":[{"id":"one","name":"Один"}]}) };
        let (_, schema) = prepare_request(&empty).unwrap(); let flat = serde_json::to_string(&schema).unwrap();
        for unavailable in ["followup","choose","usePreviousFile","usePreviousPrinter","otherPrinter","correctPreviousQuery"] { assert!(!flat.contains(unavailable), "{unavailable}"); }
        assert!(flat.contains("afterPrint"), "A future stock request may ask for file selection");
        let current = SemanticRequest { text:"Третий".into(), context:json!({"printers":[{"id":"one","name":"Один"}],"awaiting":"choice","selectedFile":{"name":"корпус"},"selectedPrinterId":"one","fileChoices":[{"number":3,"name":"корпус","printerId":"one"}]}) };
        let (_, schema) = prepare_request(&current).unwrap();
        let choice = schema["anyOf"].as_array().unwrap().iter().find(|v| v["properties"]["kind"]["const"] == "choose").unwrap();
        assert_eq!(choice["properties"]["choice"], json!({"enum":[3]}));
        assert!(serde_json::to_string(&schema).unwrap().contains("usePreviousFile"));
    }
    #[test]
    fn request_limits_are_checked_before_loading_the_model() {
        assert!(prepare_request(&SemanticRequest { text:" ".into(), context:json!({"printers":[]}) }).is_err());
        assert!(prepare_request(&SemanticRequest { text:"я".repeat(301), context:json!({"printers":[]}) }).is_err());
        assert!(prepare_request(&SemanticRequest { text:"Вопрос".into(), context:json!({"printers":[],"payload":"x".repeat(MAX_REQUEST_BYTES)}) }).is_err());
    }
    #[test]
    fn parses_bounded_http_content_length_and_chunked_responses() {
        let response = parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!(response.status, 200); assert_eq!(response.body, b"{}");
        let response = parse_http_response(b"HTTP/1.1 503 Loading\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\n\r\n").unwrap();
        assert_eq!(response.status, 503); assert_eq!(response.body, b"{}");
        let invalid: &[&[u8]] = &[
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}extra",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\nx",
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nHTTP/1.1 200 OK",
        ];
        for bytes in invalid { assert!(parse_http_response(bytes).is_err()); }
        assert!(parse_http_response(&vec![b'a'; MAX_HTTP_HEADERS + 1]).is_err());
    }
    #[test]
    fn cancellation_is_checked_before_connecting_to_any_local_service() {
        assert!(check_cancelled(&AtomicBool::new(true)).is_err());
    }
    #[test]
    fn preparation_waits_for_the_existing_owner_and_propagates_initialization_failure() {
        use std::sync::mpsc;

        let root = std::env::temp_dir().join(format!("kf-semantic-missing-{}", std::process::id()));
        assert!(!root.exists());
        let owner = WORKER.lock().unwrap();
        assert!(owner.is_none());
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let pending = thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx.send(prepare_worker(&root)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let early = done_rx.recv_timeout(Duration::from_millis(100));
        let waited = matches!(&early, Err(mpsc::RecvTimeoutError::Timeout));
        drop(owner);
        let result = match early {
            Ok(result) => result,
            Err(_) => done_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        };
        pending.join().unwrap();
        assert!(waited, "preparation returned before the existing initialization owner released readiness");
        assert!(result.unwrap_err().contains("нет модуля понимания"), "missing assets must not report successful preparation");
    }
    #[test]
    fn cancellation_before_registration_is_consumed_and_retention_is_bounded() {
        let id = "unit-cancel-before-semantic-claim".to_string();
        cancel_request(id.clone()).unwrap();
        assert!(ActiveRequest::claim(id).is_err());
        let now = Instant::now();
        let mut rows = Vec::new();
        for number in 0..MAX_CANCELLED + 8 { remember_cancelled(&mut rows, format!("request-{number}"), now); }
        assert_eq!(rows.len(), MAX_CANCELLED);
        assert_eq!(rows.first().unwrap().0, "request-8");
        remember_cancelled(&mut rows, "request-8".into(), now);
        assert_eq!(rows.len(), MAX_CANCELLED);
        prune_cancelled(&mut rows, now + CANCEL_TTL);
        assert!(rows.is_empty());
        assert!(cancel_request("bad\nrequest".into()).is_err());
    }
    #[test]
    fn wire_schema_keeps_kind_before_required_and_optional_fields() {
        let schema = json!({"anyOf":[
            {"type":"object","properties":{"printerId":{"enum":["one"]},"filter":{"enum":["free"]},"kind":{"const":"printers"}},"required":["kind","filter"]},
            {"type":"object","properties":{"quantity":{"type":"integer"},"otherPrinter":{"type":"boolean"},"query":{"type":"string"},"kind":{"const":"plan"}},"required":["kind","query","quantity"]},
            {"type":"object","properties":{"printerId":{"enum":["one"]},"action":{"enum":["pause"]},"kind":{"const":"control"}},"required":["kind","action"]},
            {"type":"object","properties":{"printerId":{"enum":["one"]},"minutes":{"type":"integer"},"mode":{"const":"after"},"kind":{"const":"forecast"}},"required":["kind","mode","minutes"]}
        ]});
        let encoded = schema_json(&schema).unwrap();
        assert!(encoded.contains("\"properties\":{\"kind\":{\"const\":\"printers\"},\"filter\":"));
        assert!(encoded.contains("\"properties\":{\"kind\":{\"const\":\"plan\"},\"query\":{\"type\":\"string\"},\"quantity\":"));
        assert!(encoded.contains("\"properties\":{\"kind\":{\"const\":\"control\"},\"action\":"));
        assert!(encoded.contains("\"properties\":{\"kind\":{\"const\":\"forecast\"},\"mode\":{\"const\":\"after\"},\"minutes\":"));
        let bytes = completion_payload("Текст \"в кавычках\"", Some(&schema), 192).unwrap();
        let wire = std::str::from_utf8(&bytes).unwrap();
        assert!(wire.contains(&format!("\"json_schema\":{encoded}")));
        let decoded: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded["json_schema"], schema);
        assert_eq!(decoded["prompt"], "Текст \"в кавычках\"");
        assert_eq!(decoded["cache_prompt"], true);
    }
    #[test]
    fn model_integrity_streams_known_bytes_and_rejects_size_hash_and_missing_files() {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let mut nonce = [0; 16]; getrandom(&mut nonce).unwrap();
        let directory = std::env::temp_dir().join(format!("kf-semantic-model-test-{}", hex::encode(nonce)));
        fs::create_dir(&directory).unwrap();
        let _cleanup = Cleanup(directory.clone());
        let path = directory.join("model.gguf");
        let bytes = b"GGUF-small-test-payload";
        fs::write(&path, bytes).unwrap();
        let hash = hex::encode(Sha256::digest(bytes));
        let cancelled = AtomicBool::new(false);
        let cache = Mutex::new(None);
        verify_model_file(&path, bytes.len() as u64, &hash, &cancelled, &cache).unwrap();
        let expected = cache.lock().unwrap().clone().unwrap();
        assert_eq!(expected.path, fs::canonicalize(&path).unwrap());
        assert_eq!(expected.bytes, bytes.len() as u64);
        verify_model_file(&path, bytes.len() as u64, &hash, &cancelled, &cache).unwrap();
        assert_eq!(cache.lock().unwrap().as_ref(), Some(&expected));
        assert!(verify_model_file(&path, bytes.len() as u64 + 1, &hash, &cancelled, &cache).is_err());
        assert!(cache.lock().unwrap().is_none());
        assert!(verify_model_file(&path, bytes.len() as u64, &"0".repeat(64), &cancelled, &cache).is_err());
        assert!(cache.lock().unwrap().is_none());
        verify_model_file(&path, bytes.len() as u64, &hash, &cancelled, &cache).unwrap();
        assert!(verify_model_file(&path, bytes.len() as u64, &hash, &AtomicBool::new(true), &cache).is_err());
        assert!(cache.lock().unwrap().is_none());
        fs::remove_file(&path).unwrap();
        assert!(verify_model_file(&path, bytes.len() as u64, &hash, &cancelled, &cache).is_err());
    }
}

