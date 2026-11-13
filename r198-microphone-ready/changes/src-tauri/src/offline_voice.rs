//! Local speech processes. Microphone WAV and synthesized PCM use pipes only.
use super::*;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};

static RECOGNIZING: Mutex<()> = Mutex::new(());
static SYNTHESIZING: Mutex<()> = Mutex::new(());
static RECOGNIZER: Mutex<Option<SpeechWorker>> = Mutex::new(None);
static SYNTHESIZER: Mutex<Option<SpeechWorker>> = Mutex::new(None);
const MAX_WAVE: usize = 44 + 20 * 16_000 * 2;
const MAX_PCM: usize = 48_000 * 2 * 120;
const RECOGNITION_FRAME_MAGIC: &[u8; 8] = b"KFWHSR01";
const MAX_CONTEXT_HINT_ITEMS: usize = 16;
const MAX_CONTEXT_HINT_ITEM_CHARS: usize = 64;
const MAX_CONTEXT_HINT_CHARS: usize = 512;
const MAX_CONTEXT_HINT_BYTES: usize = 1024;

// Context is bounded vocabulary for this recording only. It is never an action,
// an argv value, a file path to open, or a substitute for print confirmation.
fn recognition_request(wave: Vec<u8>, context_hints: Option<Vec<String>>) -> Result<Vec<u8>, String> {
    validate_wave(&wave)?;
    let hints = context_hints.unwrap_or_default();
    if hints.len() > MAX_CONTEXT_HINT_ITEMS { return Err("Слишком много речевых подсказок".into()); }
    let mut seen = std::collections::HashSet::new();
    let mut vocabulary = Vec::new();
    for hint in hints {
        if hint.is_empty() || hint.len() > MAX_CONTEXT_HINT_ITEM_CHARS * 4
            || hint.trim() != hint || hint.chars().count() > MAX_CONTEXT_HINT_ITEM_CHARS
            || !hint.chars().any(char::is_alphanumeric)
            || hint.chars().any(|c| !c.is_alphanumeric() && !" ._()-".contains(c))
        { return Err("Некорректная речевая подсказка".into()); }
        let key = hint.to_lowercase().replace('ё', "е");
        if matches!(key.as_str(), "подтверждаю печать" | "подтвердить печать" | "запускай печать" | "отмена" | "отмени" | "отменить" | "не печатай" | "нет" | "да") {
            return Err("Команда не может быть речевой подсказкой".into());
        }
        if seen.insert(key) { vocabulary.push(hint); }
    }
    if vocabulary.is_empty() { return Ok(wave); }
    let prompt = vocabulary.join(". ");
    if prompt.len() > MAX_CONTEXT_HINT_BYTES || prompt.chars().count() > MAX_CONTEXT_HINT_CHARS {
        return Err("Речевые подсказки превысили ограничение".into());
    }
    let mut request = Vec::with_capacity(RECOGNITION_FRAME_MAGIC.len() + 4 + prompt.len() + wave.len());
    request.extend_from_slice(RECOGNITION_FRAME_MAGIC);
    request.extend_from_slice(&(prompt.len() as u32).to_le_bytes());
    request.extend_from_slice(prompt.as_bytes());
    request.extend_from_slice(&wave);
    Ok(request)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecognitionModel {
    Base,
    Small,
}

impl RecognitionModel {
    fn parse(model_id: Option<&str>) -> Result<Self, String> {
        match model_id {
            None | Some("base") => Ok(Self::Base),
            Some("small") => Ok(Self::Small),
            _ => Err("Неизвестная модель распознавания".into()),
        }
    }

    fn filename(self) -> &'static str {
        match self {
            Self::Base => "ggml-base-q5_1.bin",
            Self::Small => "ggml-small-q5_1.bin",
        }
    }
}

#[derive(Serialize)]
pub(crate) struct SpeechStatus {
    recognition: bool,
    synthesis: bool,
}

/// Распознанный текст вместе с уверенностью модели.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribedSpeech {
    text: String,
    /// Средняя вероятность токенов, 0..1. Ниже порога запись стоит переспросить.
    confidence: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SynthesizedSpeech {
    pcm: Vec<u8>,
    sample_rate: u32,
}

fn speech_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|path| path.join("speech"))
        .map_err(|_| "Не найден каталог речевого модуля".into())
}

fn tool(root: &Path, name: &str) -> PathBuf {
    root.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    })
}

#[tauri::command]
pub(crate) fn voice_tools_status(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
) -> Result<SpeechStatus, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = speech_root(&app)?;
    Ok(SpeechStatus {
        recognition: tool(&root.join("whisper"), "whisper-worker").is_file()
            && root.join("whisper/ggml-base-q5_1.bin").is_file()
            && root.join("whisper/ggml-small-q5_1.bin").is_file()
            && root.join("whisper/recognition.args").is_file(),
        synthesis: tool(&root.join("silero/python"), "python").is_file()
            && root.join("silero/python/Lib/site-packages/torch/__init__.py").is_file()
            && root.join("silero/tts.py").is_file()
            && root.join("silero/v5_6_ru.pt").is_file(),
    })
}

// One model per app-owned process. Closing the app closes stdin and both
// workers exit. Readers bound allocations; a timeout kills and reaps the worker.
struct SpeechWorker {
    root: PathBuf,
    recognition_model: Option<RecognitionModel>,
    child: ChildGuard,
    input: Option<std::process::ChildStdin>,
    output: Receiver<Result<Vec<u8>, String>>,
    reader: Option<thread::JoinHandle<()>>,
    errors: Option<thread::JoinHandle<()>>,
}

impl SpeechWorker {
    fn start(root: &Path, synthesis: bool, model: RecognitionModel) -> Result<Self, String> {
        let command = if synthesis {
            let mut command = Command::new(tool(&root.join("python"), "python"));
            command.args(["-I", "-X", "utf8", "tts.py", "--worker"]);
            command
        } else {
            let mut command = Command::new(tool(root, "whisper-worker"));
            // Only a fixed ASCII basename from the model allowlist reaches argv.
            command.arg(model.filename());
            command
        };
        let mut worker = Self::start_command(root, command, if synthesis { MAX_PCM } else { 8192 })?;
        if !synthesis { worker.recognition_model = Some(model); }
        Ok(worker)
    }

    fn start_command(root: &Path, mut command: Command, limit: usize) -> Result<Self, String> {
        command.current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = ChildGuard(command.spawn().map_err(|_| "Не удалось запустить речевой модуль")?);
        let input = child.0.stdin.take().ok_or("Нет входа речевого модуля")?;
        let mut stdout = child.0.stdout.take().ok_or("Нет выхода речевого модуля")?;
        let mut stderr = child.0.stderr.take().ok_or("Нет журнала речевого модуля")?;
        let (sender, output) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || loop {
            let mut read = || -> Result<Vec<u8>, String> {
                let mut size = [0; 4];
                stdout.read_exact(&mut size).map_err(|_| "Речевой модуль закрыл соединение")?;
                let size = u32::from_le_bytes(size);
                let failed = size & 0x8000_0000 != 0;
                let size = (size & 0x7fff_ffff) as usize;
                if size > limit { return Err("Ответ речевого модуля превысил ограничение".into()); }
                let mut bytes = vec![0; size];
                stdout.read_exact(&mut bytes).map_err(|_| "Неполный ответ речевого модуля")?;
                if failed { return Err("Речевой модуль не смог обработать запись или текст".into()); }
                Ok(bytes)
            };
            let result = read();
            let failed = result.is_err();
            if sender.try_send(result).is_err() || failed { break; }
        });
        let errors = thread::spawn(move || { let _ = std::io::copy(&mut stderr, &mut std::io::sink()); });
        let worker = Self { root: root.to_path_buf(), recognition_model: None, child, input: Some(input), output, reader: Some(reader), errors: Some(errors) };
        let ready = worker.output.recv_timeout(Duration::from_secs(60))
            .map_err(|_| "Речевой модуль не успел подготовиться")??;
        if !ready.is_empty() { return Err("Некорректный запуск речевого модуля".into()); }
        Ok(worker)
    }

    fn reusable(&mut self, root: &Path, synthesis: bool, model: RecognitionModel) -> bool {
        self.root == root
            && (synthesis || self.recognition_model == Some(model))
            && matches!(self.child.0.try_wait(), Ok(None))
    }

    fn request(&mut self, input: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, String> {
        let mut pipe = self.input.take().ok_or("Речевой модуль отключён")?;
        let writer = thread::spawn(move || {
            let result = pipe.write_all(&(input.len() as u32).to_le_bytes())
                .and_then(|()| pipe.write_all(&input)).and_then(|()| pipe.flush());
            (pipe, result)
        });
        let response = self.output.recv_timeout(timeout)
            .map_err(|_| "Обработка речи заняла слишком много времени");
        if !matches!(&response, Ok(Ok(_))) {
            let _ = self.child.0.kill(); let _ = self.child.0.wait();
        }
        let (pipe, written) = writer.join().map_err(|_| "Ошибка передачи речи")?;
        self.input = Some(pipe);
        written.map_err(|_| "Речевой модуль не принял запись")?;
        response?
    }
}

impl Drop for SpeechWorker {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.0.kill(); let _ = self.child.0.wait();
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
        if let Some(errors) = self.errors.take() { let _ = errors.join(); }
    }
}

fn with_worker(root: &Path, synthesis: bool, model: RecognitionModel, input: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let slot = if synthesis { &SYNTHESIZER } else { &RECOGNIZER };
    // Подготовка не должна ждать мьютекс: распознавание предыдущей команды держит
    // его до двух минут, и нажатие на микрофон в это время выглядело как
    // зависание приложения. Возвращаем понятный отказ вместо ожидания.
    // Само распознавание по-прежнему ждёт своей очереди.
    let preparing = input.is_none();
    let mut slot = if preparing {
        slot.try_lock().map_err(|_| "Идёт распознавание предыдущей команды. Подождите пару секунд и повторите.")?
    } else {
        slot.lock().map_err(|_| "Речевой модуль недоступен")?
    };
    let restart = match slot.as_mut() {
        Some(worker) => !worker.reusable(root, synthesis, model),
        None => true,
    };
    if restart { *slot = None; *slot = Some(SpeechWorker::start(root, synthesis, model)?); }
    if let Some(input) = input {
        // CPU-only runners transcribe a padded phrase in ~40s; keep the ceiling generous.
        let result = slot.as_mut().ok_or("Речевой модуль не подготовлен")?.request(input, Duration::from_secs(120));
        if result.is_err() { *slot = None; }
        result
    } else { Ok(Vec::new()) }
}

#[tauri::command]
pub(crate) async fn voice_prepare(
    app: AppHandle, auth: State<'_, AuthState>, session_token: String, engine: String, model_id: Option<String>,
) -> Result<(), String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let synthesis = match engine.as_str() { "recognition" => false, "synthesis" => true, _ => return Err("Неизвестный речевой модуль".into()) };
    let model = RecognitionModel::parse(model_id.as_deref())?;
    let root = speech_root(&app)?.join(if synthesis { "silero" } else { "whisper" });
    bounded_spawn_blocking(ExecutionClass::FileIo, move || with_worker(&root, synthesis, model, None).map(|_| ()))
        .await.map_err(|_| "Не удалось подготовить речевой модуль")?
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(test)]
fn run_tool(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|_| "Не удалось запустить локальный речевой движок")?,
    );
    let mut stdin = child.0.stdin.take().ok_or("Нет входа речевого движка")?;
    let stdout = child.0.stdout.take().ok_or("Нет выхода речевого движка")?;
    let stderr = child.0.stderr.take().ok_or("Нет журнала речевого движка")?;
    let output = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    // Drain diagnostics without retaining microphone data or unbounded logs.
    let errors =
        thread::spawn(move || std::io::copy(&mut stderr.take(64 * 1024), &mut std::io::sink()));
    let writer = thread::spawn(move || stdin.write_all(&input));
    let started = Instant::now();
    let status =
        loop {
            match child.0.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(_) => break Err("Не удалось проверить речевой движок"),
                Ok(None) if started.elapsed() >= timeout => break Err(
                    "Обработка речи заняла слишком много времени. Повторите более короткую фразу",
                ),
                Ok(None) => thread::sleep(Duration::from_millis(40)),
            }
        };
    // Close every pipe and reap the child even when timed out or input is rejected.
    if status.is_err() {
        let _ = child.0.kill();
        let _ = child.0.wait();
    }
    let written = writer
        .join()
        .map_err(|_| "Ошибка передачи записи речевому движку")?;
    let _ = errors.join();
    let bytes = output
        .join()
        .map_err(|_| "Ошибка чтения речи")?
        .map_err(|_| "Не удалось прочитать ответ речевого движка")?;
    if !status?.success() {
        return Err(
            "Локальный речевой движок завершился с ошибкой. Проверьте речевой модуль".into(),
        );
    }
    written.map_err(|_| "Речевой движок не принял запись полностью")?;
    if bytes.len() > limit {
        return Err("Ответ речевого движка превысил ограничение".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave() -> Vec<u8> {
        let mut wave = vec![0; 44 + 32_000];
        wave[0..4].copy_from_slice(b"RIFF");
        let size = wave.len() as u32;
        wave[4..8].copy_from_slice(&(size - 8).to_le_bytes());
        wave[8..16].copy_from_slice(b"WAVEfmt ");
        wave[16..20].copy_from_slice(&16u32.to_le_bytes());
        wave[20..22].copy_from_slice(&1u16.to_le_bytes());
        wave[22..24].copy_from_slice(&1u16.to_le_bytes());
        wave[24..28].copy_from_slice(&16_000u32.to_le_bytes());
        wave[28..32].copy_from_slice(&32_000u32.to_le_bytes());
        wave[32..34].copy_from_slice(&2u16.to_le_bytes());
        wave[34..36].copy_from_slice(&16u16.to_le_bytes());
        wave[36..40].copy_from_slice(b"data");
        wave[40..44].copy_from_slice(&32_000u32.to_le_bytes());
        wave
    }

    #[test]
    fn validates_exact_audio_format_and_bounds() {
        assert!(validate_wave(&wave()).is_ok());
        for index in [0, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40] {
            let mut data = wave();
            data[index] ^= 1;
            assert!(
                validate_wave(&data).is_err(),
                "accepted corrupted field {index}"
            );
        }
        assert!(validate_wave(&[]).is_err());
        assert!(validate_wave(&vec![0; MAX_WAVE + 1]).is_err());
    }

    #[test]
    fn recognition_context_frames_keep_legacy_audio_and_unicode_vocabulary_exact() {
        let original = wave();
        assert_eq!(recognition_request(original.clone(), None).unwrap(), original);
        assert_eq!(recognition_request(original.clone(), Some(vec![])).unwrap(), original);
        let prompt = "K1 Max. Держатель телефона 12";
        let request = recognition_request(original.clone(), Some(vec!["K1 Max".into(), "Держатель телефона 12".into()])).unwrap();
        assert_eq!(&request[..8], RECOGNITION_FRAME_MAGIC);
        assert_eq!(u32::from_le_bytes(request[8..12].try_into().unwrap()) as usize, prompt.len());
        assert_eq!(&request[12..12 + prompt.len()], prompt.as_bytes());
        assert_eq!(&request[12 + prompt.len()..], original);
    }

    #[test]
    fn recognition_context_deduplicates_without_retaining_a_previous_recording() {
        let first = recognition_request(wave(), Some(vec!["Держатель".into(), "держатель".into()])).unwrap();
        let second = recognition_request(wave(), Some(vec!["Кронштейн".into()])).unwrap();
        assert_eq!(String::from_utf8(first[12..12 + "Держатель".len()].to_vec()).unwrap(), "Держатель");
        assert_eq!(String::from_utf8(second[12..12 + "Кронштейн".len()].to_vec()).unwrap(), "Кронштейн");
        assert_eq!(recognition_request(wave(), None).unwrap(), wave());
    }

    #[test]
    fn recognition_context_rejects_malformed_or_command_like_vocabulary() {
        for hint in ["", " ", "...", " ведущий", "хвост ", "новая\nстрока", "путь/к/файлу", "слово\u{202e}назад", "подтверждаю печать", "Запускай печать", "да"] {
            assert!(recognition_request(wave(), Some(vec![hint.into()])).is_err(), "accepted {hint:?}");
        }
        assert!(recognition_request(wave(), Some(vec!["я".repeat(65)])).is_err());
        assert!(recognition_request(wave(), Some((0..17).map(|index| format!("Файл {index}")).collect())).is_err());
        let too_many_characters = (0..8).map(|index| format!("{}{index}", "x".repeat(63))).collect();
        assert!(recognition_request(wave(), Some(too_many_characters)).is_err());
        let too_many_utf8_bytes = (0..11).map(|index| format!("{}{index}", "架".repeat(32))).collect();
        assert!(recognition_request(wave(), Some(too_many_utf8_bytes)).is_err());
        assert!(recognition_request(vec![0; MAX_WAVE + 1], Some(vec!["Держатель".into()])).is_err());
    }

    fn python(code: &str) -> Command {
        let mut command = Command::new(std::env::var("KF_TEST_PYTHON").expect("test Python path"));
        command.args(["-c", code]);
        command
    }

    #[test]
    fn process_uses_memory_pipes() {
        let output = run_tool(
            python("import sys; sys.stdout.buffer.write(sys.stdin.buffer.read().upper())"),
            b"audio bytes".to_vec(),
            Duration::from_secs(3),
            100,
        )
        .unwrap();
        assert_eq!(output, b"AUDIO BYTES");
    }

    #[test]
    fn process_timeout_is_bounded() {
        let started = Instant::now();
        assert!(run_tool(
            python("import time; time.sleep(10)"),
            vec![],
            Duration::from_millis(50),
            100
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn process_output_is_bounded() {
        assert!(run_tool(
            python("import sys; sys.stdout.buffer.write(b'x'*1000000)"),
            vec![],
            Duration::from_secs(3),
            100
        )
        .is_err());
    }

    #[test]
    fn recognition_model_defaults_to_base_and_rejects_non_allowlisted_paths() {
        assert_eq!(RecognitionModel::parse(None).unwrap(), RecognitionModel::Base);
        assert_eq!(RecognitionModel::parse(Some("base")).unwrap().filename(), "ggml-base-q5_1.bin");
        assert_eq!(RecognitionModel::parse(Some("small")).unwrap().filename(), "ggml-small-q5_1.bin");
        for value in ["", "tiny", "Base", "../small", "ggml-small-q5_1.bin", "C:\\model.bin", "модель"] {
            assert!(RecognitionModel::parse(Some(value)).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn recognition_worker_reuse_requires_same_model_and_root() {
        let command = python("import sys; sys.stdout.buffer.write(bytes(4)); sys.stdout.buffer.flush(); sys.stdin.buffer.read()");
        let root = std::env::temp_dir();
        let mut worker = SpeechWorker::start_command(&root, command, 1024).unwrap();
        worker.recognition_model = Some(RecognitionModel::Base);
        assert!(worker.reusable(&root, false, RecognitionModel::Base));
        assert!(!worker.reusable(&root, false, RecognitionModel::Small));
        assert!(!worker.reusable(&root.join("another-resource-root"), false, RecognitionModel::Base));
        assert!(worker.reusable(&root, true, RecognitionModel::Small));
    }

    #[test]
    fn warm_worker_reuses_process_for_five_requests() {
        let command = python("import sys,struct; r=sys.stdin.buffer; w=sys.stdout.buffer; w.write(bytes(4)); w.flush()\nwhile True:\n h=r.read(4)\n if not h: break\n b=r.read(struct.unpack('<I',h)[0]).upper(); w.write(struct.pack('<I',len(b))+b); w.flush()\n");
        let mut worker = SpeechWorker::start_command(&std::env::temp_dir(), command, 1024).unwrap();
        let process = worker.child.0.id();
        for _ in 0..5 {
            assert_eq!(worker.request(b"command".to_vec(), Duration::from_secs(3)).unwrap(), b"COMMAND");
            assert_eq!(worker.child.0.id(), process);
            assert!(worker.child.0.try_wait().unwrap().is_none());
        }
    }

    #[test]
    fn warm_worker_timeout_kills_the_child_and_releases_pipes() {
        let command = python("import sys,time; sys.stdout.buffer.write(bytes(4)); sys.stdout.buffer.flush(); sys.stdin.buffer.read(4); time.sleep(30)");
        let mut worker = SpeechWorker::start_command(&std::env::temp_dir(), command, 1024).unwrap();
        let started = Instant::now();
        assert!(worker.request(vec![1], Duration::from_millis(50)).is_err());
        assert!(worker.child.0.try_wait().unwrap().is_some());
        drop(worker);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn warm_worker_rejects_oversized_frame_without_allocating_it() {
        let command = python("import sys,struct; w=sys.stdout.buffer; w.write(bytes(4)); w.flush(); r=sys.stdin.buffer; n=struct.unpack('<I',r.read(4))[0]; r.read(n); w.write(struct.pack('<I',1000000000)); w.flush()");
        let mut worker = SpeechWorker::start_command(&std::env::temp_dir(), command, 1024).unwrap();
        assert!(worker.request(vec![1], Duration::from_secs(3)).is_err());
        assert!(worker.child.0.try_wait().unwrap().is_some());
    }
}

fn validate_wave(wave: &[u8]) -> Result<(), String> {
    if wave.len() < 44 + 3_200
        || wave.len() > MAX_WAVE
        || (wave.len() - 44) % 2 != 0
        || &wave[0..4] != b"RIFF"
        || &wave[8..16] != b"WAVEfmt "
        || &wave[36..40] != b"data"
        || u32::from_le_bytes(wave[16..20].try_into().unwrap()) != 16
        || u16::from_le_bytes(wave[20..22].try_into().unwrap()) != 1
        || u16::from_le_bytes(wave[22..24].try_into().unwrap()) != 1
        || u32::from_le_bytes(wave[24..28].try_into().unwrap()) != 16_000
        || u32::from_le_bytes(wave[28..32].try_into().unwrap()) != 32_000
        || u16::from_le_bytes(wave[32..34].try_into().unwrap()) != 2
        || u16::from_le_bytes(wave[34..36].try_into().unwrap()) != 16
        || u32::from_le_bytes(wave[40..44].try_into().unwrap()) as usize != wave.len() - 44
        || u32::from_le_bytes(wave[4..8].try_into().unwrap()) as usize != wave.len() - 8
    {
        return Err(
            "Некорректная запись микрофона: нужен PCM WAV 16 кГц длительностью до 20 секунд".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn voice_transcribe(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    wave: Vec<u8>,
    model_id: Option<String>,
    context_hints: Option<Vec<String>>,
) -> Result<TranscribedSpeech, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let request = recognition_request(wave, context_hints)?;
    let model = RecognitionModel::parse(model_id.as_deref())?;
    let root = speech_root(&app)?.join("whisper");
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let _guard = RECOGNIZING.try_lock().map_err(|_| "Распознавание уже выполняется")?;
        if !root.join(model.filename()).is_file() { return Err("Не установлена выбранная модель Whisper".into()); }
        if !root.join("recognition.args").is_file() { return Err("Не установлены параметры распознавания".into()); }
        let bytes = with_worker(&root, false, model, Some(request))?;
        let raw = String::from_utf8(bytes).map_err(|_| "Ошибка кодировки распознанной речи")?;
        // Новый воркер отдаёт "уверенность	текст". Прежний формат без префикса
        // остаётся допустимым: тогда уверенность неизвестна и считаем её высокой.
        let (confidence, text) = match raw.split_once('\t') {
            Some((prefix, rest)) => (prefix.trim().parse::<f32>().ok(), rest),
            None => (None, raw.as_str()),
        };
        let text: String = text
            .replace("[BLANK_AUDIO]", "")
            .replace("[ Silence ]", "")
            .trim()
            .chars()
            .take(1_000)
            .collect();
        Ok(TranscribedSpeech {
            text,
            confidence: confidence.map_or(1.0, |value| value.clamp(0.0, 1.0)),
        })
    }).await.map_err(|_| "Ошибка рабочего процесса распознавания")?
}

#[tauri::command]
pub(crate) async fn voice_synthesize(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    text: String,
    voice_id: String,
) -> Result<SynthesizedSpeech, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    if voice_id != "kseniya"
        || text.trim().is_empty()
        || text.chars().count() > 1_200
        || text.chars().any(|c| c.is_control())
    {
        return Err("Некорректные параметры озвучивания".into());
    }
    let root = speech_root(&app)?.join("silero");
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let _guard = SYNTHESIZING
            .try_lock()
            .map_err(|_| "Озвучивание ещё подготавливается")?;
        let model = root.join("v5_6_ru.pt");
        if !model.is_file() {
            return Err("Не установлен выбранный нейроголос".into());
        }
        let pcm = with_worker(&root, true, RecognitionModel::Base, Some(text.into_bytes()))?;
        if pcm.is_empty() || pcm.len() % 2 != 0 {
            return Err("Нейроголос не вернул звук".into());
        }
        Ok(SynthesizedSpeech {
            pcm,
            sample_rate: 48_000,
        })
    })
    .await
    .map_err(|_| "Ошибка рабочего процесса озвучивания")?
}
