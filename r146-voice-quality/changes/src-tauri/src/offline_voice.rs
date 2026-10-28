//! Local speech processes. Microphone WAV and synthesized PCM use pipes only.
use super::*;
use std::process::{Child, Command, Stdio};

static RECOGNIZING: Mutex<()> = Mutex::new(());
static SYNTHESIZING: Mutex<()> = Mutex::new(());
const MAX_WAVE: usize = 44 + 20 * 16_000 * 2;
const MAX_PCM: usize = 22_050 * 2 * 120;

#[derive(Serialize)]
pub(crate) struct SpeechStatus {
    recognition: bool,
    synthesis: bool,
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
        recognition: tool(&root.join("whisper"), "whisper-cli").is_file()
            && root.join("whisper/ggml-small-q5_1.bin").is_file(),
        synthesis: tool(&root.join("piper"), "piper").is_file()
            && root.join("piper/ru_RU-denis-medium.onnx").is_file(),
    })
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

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
                    "Распознавание заняло слишком много времени. Повторите более короткую команду",
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
) -> Result<String, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    validate_wave(&wave)?;
    let root = speech_root(&app)?.join("whisper");
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let _guard = RECOGNIZING.try_lock().map_err(|_| "Распознавание уже выполняется")?;
        let model = root.join("ggml-small-q5_1.bin");
        if !model.is_file() { return Err("Не установлена модель Whisper".into()); }
        let mut command = Command::new(tool(&root, "whisper-cli"));
        command.current_dir(&root).arg("-m").arg("ggml-small-q5_1.bin")
            .args(["-f", "-", "-of", "transcript-memory-only", "-l", "ru", "-t", "4", "-np", "-nt", "-ng"])
            .args(["--prompt", "Принтер K1 Max, K1C, Ender KE, Flashforge 5M. Найди файл, поставь на печать, корпус, кронштейн, остаток пластика."]);
        let bytes = run_tool(command, wave, Duration::from_secs(90), 8_192)?;
        let text = String::from_utf8(bytes).map_err(|_| "Ошибка кодировки распознанной речи")?;
        Ok(text.replace("[BLANK_AUDIO]", "").replace("[ Silence ]", "").trim().chars().take(1_000).collect())
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
    if !matches!(voice_id.as_str(), "denis" | "dmitri")
        || text.trim().is_empty()
        || text.chars().count() > 1_200
        || text.chars().any(|c| c.is_control())
    {
        return Err("Некорректные параметры озвучивания".into());
    }
    let root = speech_root(&app)?.join("piper");
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let _guard = SYNTHESIZING
            .try_lock()
            .map_err(|_| "Озвучивание ещё подготавливается")?;
        let model = root.join(format!("ru_RU-{voice_id}-medium.onnx"));
        if !model.is_file() {
            return Err("Не установлен выбранный нейроголос".into());
        }
        let mut command = Command::new(tool(&root, "piper"));
        command
            .current_dir(&root)
            .arg("--model")
            .arg(format!("ru_RU-{voice_id}-medium.onnx"))
            .args([
                "--output-raw",
                "--espeak_data",
                "espeak-ng-data",
                "--sentence_silence",
                "0.15",
                "--length_scale",
                "1.0",
            ]);
        let pcm = run_tool(
            command,
            format!("{text}\n").into_bytes(),
            Duration::from_secs(40),
            MAX_PCM,
        )?;
        if pcm.is_empty() || pcm.len() % 2 != 0 {
            return Err("Нейроголос не вернул звук".into());
        }
        Ok(SynthesizedSpeech {
            pcm,
            sample_rate: 22_050,
        })
    })
    .await
    .map_err(|_| "Ошибка рабочего процесса озвучивания")?
}
