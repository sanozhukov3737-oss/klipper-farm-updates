//! Команда, показывающая оператору, где реально лежат данные приложения.
//!
//! Резолвер из `storage_paths` выбирает корень по переменным окружения и наличию тома D,
//! но до этой команды пользователь не мог увидеть результат выбора. На машине без диска D
//! данные тихо остаются на системном диске, и об этом нигде не сообщалось.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::storage_paths;

/// Свободное место ниже этого порога считается поводом перенести данные.
const LOW_SPACE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageLocation {
    /// Каталог, в котором живут база, журналы и библиотека G-code.
    root: String,
    /// Как корень был выбран: переменная окружения, том D или прежний каталог AppData.
    source: &'static str,
    /// Переменная окружения, задавшая корень, если она есть.
    override_variable: Option<String>,
    /// Свободное место на томе корня, если его удалось определить.
    free_bytes: Option<u64>,
    /// Свободное место ниже порога: пора переносить данные.
    low_space: bool,
    /// Данные уже на системном диске, хотя диск D доступен.
    prefer_move: bool,
    /// Подкаталоги приложения, которые существуют в выбранном корне.
    subdirectories: Vec<String>,
}

fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut available: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available as *mut u64,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        return (ok != 0).then_some(available);
    }
    #[cfg(not(windows))]
    {
        // На других платформах путь данных всё равно не показывается оператору.
        let _ = path;
        None
    }
}

fn storage_source(root: &Path, legacy: Option<&Path>) -> (&'static str, Option<String>) {
    if std::env::var_os(storage_paths::HOME_ENV).is_some_and(|value| !value.is_empty()) {
        return ("environment", Some(storage_paths::HOME_ENV.into()));
    }
    if std::env::var_os(storage_paths::DATA_DIR_ENV).is_some_and(|value| !value.is_empty()) {
        return ("environment", Some(storage_paths::DATA_DIR_ENV.into()));
    }
    match legacy {
        Some(legacy) if legacy == root => ("legacy-appdata", None),
        _ => ("preferred-disk", None),
    }
}

fn existing_subdirectories(root: &Path) -> Vec<String> {
    ["logs", "diagnostics", "verified-updates", "webview", "temp", "print-snapshots", "local-gcode-library"]
        .into_iter()
        .filter(|name| fs::metadata(root.join(name)).is_ok())
        .map(str::to_owned)
        .collect()
}

#[tauri::command]
pub(crate) async fn storage_location(
    app: AppHandle,
    auth: State<'_, crate::AuthState>,
    session_token: String,
) -> Result<StorageLocation, String> {
    // Путь данных раскрывает структуру диска, поэтому только администратору.
    crate::require_role(&app, &auth, &session_token, crate::Role::Admin)?;
    let root = storage_paths::root(&app)?;
    let legacy: Option<PathBuf> = app.path().app_data_dir().ok();
    let (source, override_variable) = storage_source(&root, legacy.as_deref());
    let free = free_bytes(&root);
    let low_space = free.is_some_and(|value| value < LOW_SPACE_BYTES);
    let prefer_move = source == "legacy-appdata" && !storage_paths::preferred_roots().is_empty();
    Ok(StorageLocation {
        root: root.to_string_lossy().into_owned(),
        source,
        override_variable,
        free_bytes: free,
        low_space,
        prefer_move,
        subdirectories: existing_subdirectories(&root),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_root_is_reported_as_legacy() {
        let root = PathBuf::from(r"D:\nowhere");
        let (source, variable) = storage_source(&root, Some(root.as_path()));
        assert_eq!(source, "legacy-appdata");
        assert_eq!(variable, None);
    }

    #[test]
    fn a_different_root_is_reported_as_preferred_disk() {
        let root = PathBuf::from(r"D:\KlipperFarmData");
        let legacy = PathBuf::from(r"C:\Users\someone\AppData\Roaming\app.klipper.farm");
        let (source, _) = storage_source(&root, Some(legacy.as_path()));
        assert_eq!(source, "preferred-disk");
    }

    #[test]
    fn only_existing_subdirectories_are_reported() {
        let root = std::env::temp_dir().join(format!("kf-storage-cmd-{}", std::process::id()));
        fs::create_dir_all(root.join("logs")).unwrap();
        let found = existing_subdirectories(&root);
        assert!(found.contains(&"logs".to_string()));
        assert!(!found.contains(&"webview".to_string()));
        let _ = fs::remove_dir_all(&root);
    }
}
