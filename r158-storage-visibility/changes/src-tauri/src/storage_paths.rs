//! Единственное место, где решается, на каком диске живут данные приложения.
//!
//! Раньше всё писалось в `%APPDATA%` и `%LOCALAPPDATA%`, то есть на системный диск.
//! Теперь корень данных выбирается по порядку:
//!
//! 1. `KF_HOME` — явное указание пользователя, всегда выигрывает;
//! 2. `KLIPPER_FARM_DATA_DIR` — тот же контракт, что уже понимает `klipper-farmd`;
//! 3. предпочтительный корень `D:\KlipperFarmData`, если такой том существует;
//! 4. `%APPDATA%\app.klipper.farm` — прежнее поведение.
//!
//! Диска D может не быть: это не ошибка, приложение просто остаётся на `%APPDATA%`.
//! Существующую базу не уводим молча: если в устаревшем корне уже лежит
//! `farm.sqlite3`, а в предпочтительном корне его нет, остаёмся на устаревшем —
//! перенос данных делает пользователь, а не запуск приложения.
//!
//! Все производные каталоги (`logs`, `diagnostics`, `verified-updates`, `webview`,
//! `temp`, `print-snapshots`) живут внутри выбранного корня, поэтому вторая точка
//! принятия решения не появляется.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Идентификатор приложения из `tauri.conf.json`; `%APPDATA%\<идентификатор>` —
/// устаревший корень данных, который продолжает читаться.
pub(crate) const APP_IDENTIFIER: &str = "app.klipper.farm";

pub(crate) const HOME_ENV: &str = "KF_HOME";
pub(crate) const DATA_DIR_ENV: &str = "KLIPPER_FARM_DATA_DIR";
/// Переменная, которую WebView2 читает при создании профиля браузера.
pub(crate) const WEBVIEW_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";

/// Имя базы, по наличию которой определяется, что в каталоге уже есть данные.
pub(crate) const DATABASE_FILENAME: &str = "farm.sqlite3";

#[cfg(windows)]
const PREFERRED_ROOTS: &[&str] = &[r"D:\KlipperFarmData"];
#[cfg(not(windows))]
const PREFERRED_ROOTS: &[&str] = &[];

fn has_database(directory: &Path) -> bool {
    directory.join(DATABASE_FILENAME).is_file()
}

/// Том предпочтительного корня должен существовать: иначе `create_dir_all`
/// создаст каталог где-то не там или упадёт с невнятной ошибкой.
fn volume_available(directory: &Path) -> bool {
    match directory.parent() {
        Some(volume) if !volume.as_os_str().is_empty() => fs::metadata(volume).is_ok_and(|m| m.is_dir()),
        _ => true,
    }
}

fn ensure_directory(directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    // Права ужесточаем как и раньше для каталога данных; на Windows это no-op,
    // на unix — 0700. Сбой прав не должен мешать запуску.
    let _ = crate::set_private_directory_permissions(directory);
    Ok(directory.to_path_buf())
}

fn env_root(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn explicit_roots() -> Vec<PathBuf> {
    [HOME_ENV, DATA_DIR_ENV]
        .into_iter()
        .filter_map(env_root)
        .collect()
}

pub(crate) fn preferred_roots() -> Vec<PathBuf> {
    PREFERRED_ROOTS
        .iter()
        .map(PathBuf::from)
        .filter(|path| volume_available(path))
        .collect()
}

/// Устаревший корень без `AppHandle` — то же значение, что отдаёт Tauri.
pub(crate) fn legacy_root_from_env() -> Option<PathBuf> {
    env_root("APPDATA")
        .or_else(|| env_root("LOCALAPPDATA"))
        .map(|base| base.join(APP_IDENTIFIER))
}

/// Чистое решение о корне: без переменных окружения и без `AppHandle`, поэтому
/// его можно проверить тестами на настоящих каталогах.
pub(crate) fn decide(
    explicit: &[PathBuf],
    preferred: &[PathBuf],
    legacy: Option<&Path>,
) -> PathBuf {
    // Явное указание пользователя уважаем без оговорок.
    for candidate in explicit {
        if let Ok(root) = ensure_directory(candidate) {
            return root;
        }
    }
    let legacy_has_database = legacy.is_some_and(has_database);
    for candidate in preferred {
        if legacy_has_database && !has_database(candidate) {
            continue;
        }
        if let Ok(root) = ensure_directory(candidate) {
            return root;
        }
    }
    if let Some(legacy) = legacy {
        if let Ok(root) = ensure_directory(legacy) {
            return root;
        }
    }
    env::temp_dir().join(APP_IDENTIFIER)
}

/// Корень данных приложения.
pub(crate) fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let legacy = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(decide(&explicit_roots(), &preferred_roots(), Some(&legacy)))
}

/// Корень данных там, где `AppHandle` ещё нет (до создания окна, в демоне).
pub(crate) fn root_without_app() -> PathBuf {
    let legacy = legacy_root_from_env();
    decide(&explicit_roots(), &preferred_roots(), legacy.as_deref())
}

pub(crate) fn subdir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    ensure_directory(&root(app)?.join(name))
}

pub(crate) fn subdir_without_app(name: &str) -> PathBuf {
    root_without_app().join(name)
}

/// Уводит профиль WebView2 (кэш Chromium) в выбранный корень.
///
/// Вызывается до создания окна: WebView2 читает переменную в момент создания
/// окружения. Если приложение всё равно живёт в `%APPDATA%`, профиль остаётся
/// на своём обычном месте в `%LOCALAPPDATA%` — незачем переносить кэш в роуминг.
pub(crate) fn configure_webview_root() {
    if env::var_os(WEBVIEW_ENV).is_some_and(|value| !value.is_empty()) {
        return;
    }
    let root = root_without_app();
    if legacy_root_from_env().as_deref() == Some(root.as_path()) {
        return;
    }
    let profile = root.join("webview");
    if ensure_directory(&profile).is_err() {
        return;
    }
    env::set_var(WEBVIEW_ENV, &profile);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = env::temp_dir().join(format!("kf-paths-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn with_database(directory: &Path) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        fs::write(directory.join(DATABASE_FILENAME), b"db").unwrap();
        directory.to_path_buf()
    }

    #[test]
    fn explicit_root_wins_over_everything() {
        let explicit = scratch("explicit");
        let preferred = scratch("preferred");
        let legacy = with_database(&scratch("legacy"));
        let root = decide(&[explicit.clone()], &[preferred], Some(&legacy));
        assert_eq!(root, explicit);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preferred_root_is_used_for_a_fresh_install() {
        let preferred = scratch("fresh-preferred");
        let legacy = scratch("fresh-legacy");
        let root = decide(&[], &[preferred.clone()], Some(&legacy));
        assert_eq!(root, preferred);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_database_in_legacy_root_is_never_abandoned() {
        let preferred = scratch("keep-preferred");
        let legacy = with_database(&scratch("keep-legacy"));
        let root = decide(&[], &[preferred], Some(&legacy));
        assert_eq!(root, legacy);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preferred_root_wins_once_it_also_holds_the_database() {
        let preferred = with_database(&scratch("both-preferred"));
        let legacy = with_database(&scratch("both-legacy"));
        let root = decide(&[], &[preferred.clone()], Some(&legacy));
        assert_eq!(root, preferred);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&legacy);
    }

    #[test]
    fn missing_volume_falls_back_to_the_legacy_root() {
        let legacy = scratch("novolume-legacy");
        let unavailable = PathBuf::from(r"Q:\KlipperFarmData");
        let root = decide(&[], &[unavailable], Some(&legacy));
        assert_eq!(root, legacy);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn subdirectories_live_inside_the_chosen_root() {
        let root = scratch("subdir-root");
        let nested = ensure_directory(&root.join("diagnostics")).unwrap();
        assert!(nested.is_dir());
        assert!(nested.starts_with(&root));
        let _ = fs::remove_dir_all(&root);
    }
}
