//! Пути и имена внутри локальной библиотеки G-code.
//!
//! Всё, что связано с раскладкой каталогов, нормализацией сегментов и защитой
//! от выхода за пределы корня. Функции не знают про Tauri, базу и сеть —
//! поэтому проверяются отдельно от приложения.

use std::path::{Path, PathBuf};

use crate::MAX_LOCAL_LIBRARY_PATH;
use std::path::Component;




pub(crate) fn windows_reserved_segment(value: &str) -> bool {
    let stem = value
        .trim_end_matches([' ', '.'])
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|number| number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9'))
}

pub(crate) fn normalize_local_library_segments(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty()
        || value.len() > MAX_LOCAL_LIBRARY_PATH
        || value.chars().any(char::is_control)
    {
        return Err("Недопустимый путь в локальной библиотеке".into());
    }
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err("Путь локальной библиотеки должен быть относительным".into());
    }
    let path = Path::new(&normalized);
    let mut segments = Vec::new();
    for component in path.components() {
        let Component::Normal(segment) = component else {
            return Err("Переходы между каталогами запрещены".into());
        };
        let segment = segment
            .to_str()
            .ok_or("Путь локальной библиотеки должен быть в UTF-8")?;
        if segment.is_empty()
            || segment.len() > 180
            || segment == "."
            || segment == ".."
            || segment.ends_with([' ', '.'])
            || segment
                .chars()
                .any(|character| "<>:\"|?*".contains(character))
            || windows_reserved_segment(segment)
        {
            return Err("Путь содержит недопустимое имя папки или файла".into());
        }
        segments.push(segment.to_string());
        if segments.len() > 48 {
            return Err("Слишком глубокая структура папок".into());
        }
    }
    if segments.is_empty() {
        return Err("Корневой каталог локальной библиотеки удалять нельзя".into());
    }
    Ok(segments)
}

pub(crate) fn normalize_local_library_path(value: &str) -> Result<String, String> {
    let segments = normalize_local_library_segments(value)?;
    let normalized = segments.join("/");
    let lower = normalized.to_ascii_lowercase();
    if !lower.ends_with(".gcode") && !lower.ends_with(".gco") {
        return Err("Разрешены только файлы .gcode и .gco".into());
    }
    Ok(normalized)
}

pub(crate) fn normalize_local_library_directory(value: &str) -> Result<String, String> {
    Ok(normalize_local_library_segments(value)?.join("/"))
}

pub(crate) fn local_library_file_path(root: &Path, value: &str) -> Result<(String, PathBuf), String> {
    let normalized = normalize_local_library_path(value)?;
    let mut path = root.to_path_buf();
    for segment in normalized.split('/') {
        path.push(segment);
    }
    Ok((normalized, path))
}

pub(crate) fn local_library_directory_path(root: &Path, value: &str) -> Result<(String, PathBuf), String> {
    let normalized = normalize_local_library_directory(value)?;
    let mut path = root.to_path_buf();
    for segment in normalized.split('/') {
        path.push(segment);
    }
    Ok((normalized, path))
}
