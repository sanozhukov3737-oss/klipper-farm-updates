use std::{
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Once,
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

const SMOKE_FLAG: &str = "--desktop-startup-smoke";
const CLIENT_BINARY_STEM: &str = "klipper-farm-client";
const STARTUP_LOG_LIMIT_BYTES: u64 = 1024 * 1024;
static WINDOW_READY: AtomicBool = AtomicBool::new(false);
static SMOKE_MODE: AtomicBool = AtomicBool::new(false);
static PANIC_HOOK: Once = Once::new();

#[derive(Clone, Debug)]
pub(crate) struct DesktopSmoke {
    marker_path: PathBuf,
}

impl DesktopSmoke {
    pub(crate) fn from_process_args() -> Result<Option<Self>, String> {
        let mut arguments = std::env::args_os();
        let _program = arguments.next();
        let mut marker_path = None;
        while let Some(argument) = arguments.next() {
            if argument != OsStr::new(SMOKE_FLAG) {
                continue;
            }
            if marker_path.is_some() {
                return Err("DESKTOP_SMOKE_ARGUMENT_DUPLICATED".into());
            }
            marker_path = Some(
                arguments
                    .next()
                    .map(PathBuf::from)
                    .ok_or("DESKTOP_SMOKE_MARKER_MISSING")?,
            );
        }
        let Some(marker_path) = marker_path else {
            return Ok(None);
        };
        validate_smoke_marker_target(&marker_path)?;
        Ok(Some(Self { marker_path }))
    }

    pub(crate) fn marker_path(&self) -> &Path {
        &self.marker_path
    }
}

pub(crate) fn smoke_requested() -> bool {
    std::env::args_os().any(|argument| argument == OsStr::new(SMOKE_FLAG))
}

pub(crate) fn set_smoke_mode(enabled: bool) {
    SMOKE_MODE.store(enabled, Ordering::Release);
}

pub(crate) fn install_panic_hook() {
    PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("panic payload is not a string");
            let location = info
                .location()
                .map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                })
                .unwrap_or_else(|| "unknown location".into());
            let detail = format!("{payload} at {location}");
            record("UNHANDLED_PANIC", &detail);
            if !window_ready() {
                show_startup_error("UNHANDLED_PANIC", &detail);
            }
            previous(info);
        }));
    });
}

pub(crate) fn process_identity() -> String {
    std::env::current_exe()
        .map(|path| format!("pid={} executable={}", std::process::id(), path.display()))
        .unwrap_or_else(|error| {
            format!(
                "pid={} executable=unavailable error={error}",
                std::process::id()
            )
        })
}

pub(crate) fn mark_window_ready(page_url: &str) {
    if !WINDOW_READY.swap(true, Ordering::AcqRel) {
        record(
            "DESKTOP_WINDOW_READY",
            &format!("window=main page_load=finished url={page_url}"),
        );
    }
}

pub(crate) fn window_ready() -> bool {
    WINDOW_READY.load(Ordering::Acquire)
}

pub(crate) fn write_smoke_marker(
    smoke: &DesktopSmoke,
    window_label: &str,
    page_url: &str,
) -> Result<(), String> {
    validate_smoke_marker_target(smoke.marker_path())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let actual_name = executable
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or("DESKTOP_BINARY_FILENAME_UNAVAILABLE")?;
    #[cfg(windows)]
    let identity_matches = actual_name.eq_ignore_ascii_case("klipper-farm-client.exe");
    #[cfg(not(windows))]
    let identity_matches = actual_name == CLIENT_BINARY_STEM;
    if !identity_matches {
        return Err(format!(
            "DESKTOP_BINARY_IDENTITY_MISMATCH expected={CLIENT_BINARY_STEM} actual={actual_name}"
        ));
    }
    if window_label != "main" {
        return Err(format!(
            "DESKTOP_WINDOW_IDENTITY_MISMATCH expected=main actual={window_label}"
        ));
    }

    let marker = serde_json::json!({
        "schemaVersion": 1,
        "binary": CLIENT_BINARY_STEM,
        "executableFile": actual_name,
        "windowLabel": window_label,
        "pageLoad": "finished",
        "pageUrl": page_url,
        "pid": std::process::id(),
        "createdAtMs": timestamp_ms(),
    });
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(smoke.marker_path())
        .map_err(|error| format!("DESKTOP_SMOKE_MARKER_CREATE_FAILED: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("DESKTOP_SMOKE_MARKER_WRITE_FAILED: {error}"))?;
    record(
        "DESKTOP_SMOKE_PASSED",
        &format!("marker={}", smoke.marker_path().display()),
    );
    Ok(())
}

pub(crate) fn record(code: &str, detail: &str) {
    let path = startup_log_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let truncate =
        fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= STARTUP_LOG_LIMIT_BYTES);
    let mut options = OpenOptions::new();
    options.create(true);
    if truncate {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    let Ok(mut file) = options.open(path) else {
        return;
    };
    let safe_code = sanitize(code, 96);
    let safe_detail = sanitize(detail, 2_048);
    let _ = writeln!(
        file,
        "{} pid={} code={} detail={}",
        timestamp_ms(),
        std::process::id(),
        safe_code,
        safe_detail
    );
    let _ = file.flush();
}

pub(crate) fn report_failure(code: &str, detail: &str) {
    record(code, detail);
    show_startup_error(code, detail);
}

pub(crate) fn startup_log_path() -> PathBuf {
    crate::storage_paths::subdir_without_app("logs").join("desktop-startup.log")
}

fn validate_smoke_marker_target(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("DESKTOP_SMOKE_MARKER_MUST_BE_ABSOLUTE".into());
    }
    if path.as_os_str().to_string_lossy().len() > 2_048 {
        return Err("DESKTOP_SMOKE_MARKER_PATH_TOO_LONG".into());
    }
    if path.extension().and_then(OsStr::to_str) != Some("json") {
        return Err("DESKTOP_SMOKE_MARKER_MUST_BE_JSON".into());
    }
    let parent = path.parent().ok_or("DESKTOP_SMOKE_MARKER_HAS_NO_PARENT")?;
    let parent_metadata = fs::metadata(parent)
        .map_err(|error| format!("DESKTOP_SMOKE_MARKER_PARENT_UNAVAILABLE: {error}"))?;
    if !parent_metadata.is_dir() {
        return Err("DESKTOP_SMOKE_MARKER_PARENT_NOT_DIRECTORY".into());
    }
    if path.exists() {
        return Err("DESKTOP_SMOKE_MARKER_ALREADY_EXISTS".into());
    }
    Ok(())
}

fn sanitize(value: &str, limit: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(limit)
        .collect()
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn show_startup_error(code: &str, detail: &str) {
    if SMOKE_MODE.load(Ordering::Acquire) {
        return;
    }
    let message = format!(
        "Klipper Farm не смог открыть рабочее окно.\n\nКод: {}\n{}\n\nДиагностика сохранена:\n{}",
        sanitize(code, 96),
        sanitize(detail, 800),
        startup_log_path().display()
    );
    #[cfg(windows)]
    {
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Klipper Farm — ошибка запуска"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // SAFETY: both UTF-16 buffers are NUL-terminated and live for the call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}
