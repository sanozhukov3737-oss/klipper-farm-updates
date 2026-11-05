use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = crate::storage_paths::root(app)?;
    secure_data_directory(&directory)?;
    Ok(directory.join("farm.sqlite3"))
}

pub(crate) fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    open_connection(&path)
}

pub(crate) fn initialize_app_database(app: &AppHandle) -> Result<(), String> {
    let path = db_path(app)?;
    let mut connection = open_connection(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    initialize_base_schema(&connection)?;
    let _ = crate::transactional_core::migrations::migrate_with_backup(
        &mut connection,
        &path,
        crate::now_ms(),
    )?;
    Ok(())
}

pub(crate) fn open_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("SQLite open {}: {error:?}", path.display()))?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA secure_delete=ON;",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

pub(crate) fn initialize_base_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS kv(
                 key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS audit(
                 id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,user TEXT NOT NULL,
                 action TEXT NOT NULL,details TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS users(
                 id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,
                 created_at INTEGER NOT NULL
             );",
        )
        .map_err(|error| error.to_string())?;
    let user_columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(users)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        rows.filter_map(Result::ok).collect::<HashSet<_>>()
    };
    if !user_columns.contains("password_hash") {
        connection
            .execute("ALTER TABLE users ADD COLUMN password_hash TEXT", [])
            .map_err(|error| error.to_string())?;
    }
    if !user_columns.contains("pin_hash") {
        connection
            .execute("ALTER TABLE users ADD COLUMN pin_hash TEXT", [])
            .map_err(|error| error.to_string())?;
    }
    let users: i64 = connection
        .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
        .unwrap_or(0);
    if users == 0 {
        connection
            .execute(
                "INSERT INTO users(id,name,role,enabled,created_at,password_hash)
                 VALUES(?1,?2,'admin',1,?3,NULL)",
                params!["admin", "Администратор", crate::now_ms()],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn secure_data_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_schema_is_idempotent_and_keeps_single_admin() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_base_schema(&connection).unwrap();
        initialize_base_schema(&connection).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM users WHERE id='admin'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
