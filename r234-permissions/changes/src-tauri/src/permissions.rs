//! Права доступа к файлам и каталогам данных.
//!
//! Только про безопасность на диске: каталог данных закрывается от других
//! пользователей системы, файлы — от чтения посторонними. Функции не знают про
//! Tauri, базу и сеть.

use std::path::Path;

#[cfg(unix)]
use std::fs;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

pub(crate) fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    #[cfg(not(any(unix, windows)))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    restrict_windows_acl(path, true)?;
    Ok(())
}

pub(crate) fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(not(any(unix, windows)))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    restrict_windows_acl(path, false)?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn restrict_windows_acl(path: &Path, directory: bool) -> Result<(), String> {
    let output = windowless_windows_command("whoami.exe")
        .args(["/user", "/fo", "table", "/nh"])
        .output()
        .map_err(|error| format!("WINDOWS_SID_TOOL_FAILED: {error}"))?;
    if !output.status.success() {
        return Err(format!("WINDOWS_SID_TOOL_REJECTED: {}", output.status));
    }
    let sid = parse_windows_sid(&output.stdout).ok_or("WINDOWS_CURRENT_USER_SID_MISSING")?;
    let principal = format!("*{sid}");
    let rights = if directory { "(OI)(CI)F" } else { "F" };
    let output = windowless_windows_command("icacls.exe")
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            &format!("{principal}:{rights}"),
            "/grant:r",
            if directory {
                "*S-1-5-18:(OI)(CI)F"
            } else {
                "*S-1-5-18:F"
            },
            "/Q",
        ])
        .output()
        .map_err(|error| format!("WINDOWS_ACL_TOOL_FAILED: {error}"))?;
    if !output.status.success() {
        return Err(format!("WINDOWS_ACL_REJECTED: {}", output.status));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn windowless_windows_command(program: &str) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
pub(crate) fn windowless_windows_command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

#[cfg(any(windows, test))]
pub(crate) fn parse_windows_sid(output: &[u8]) -> Option<String> {
    String::from_utf8_lossy(output)
        .split_ascii_whitespace()
        .map(|value| value.trim_matches(['"', '\r', '\n']).to_ascii_uppercase())
        .find(|value| {
            value.len() <= 184
                && value.starts_with("S-1-")
                && value
                    .split('-')
                    .skip(1)
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                && value.split('-').count() >= 4
        })
}
