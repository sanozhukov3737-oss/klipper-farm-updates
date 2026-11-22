//! Команды аутентификации и управления пользователями.
//!
//! Всё, что отвечает на вопрос «кто ты»: вход по паролю и PIN, Windows Hello,
//! создание и правка пользователей, сессии. Политика решения живёт в
//! auth_policy; здесь — обвязка команд и работа с базой.

use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

use crate::auth_policy;
use crate::online_updates;

/// HMAC-SHA256 — псевдоним, под которым он используется в хешировании PIN.
type HmacSha256 = Hmac<Sha256>;
// require_role, validate_password, validate_key и pbkdf2_sha256 определены
// в этом же модуле с R247, поэтому в импорте их больше нет.
use crate::{
    bounded_spawn_blocking, insert_audit, now_ms, open_db, parse_role, random_bytes, validate_pin,
    AppUser,
    AuthInner, AuthState, AuthSession, AuthStatus, HelloGrant, HelloStatus, Role, SessionRecord, UserInput,
    BOOTSTRAP_CREDENTIALS_SQL, PASSWORD_ITERATIONS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS,
};
use crate::transactional_core::engine_runtime::ExecutionClass;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use crate::windows_hello;
use crate::{HelloBusy, PIN_ITERATIONS};

pub(crate) fn user_by_id(conn: &Connection, id: &str) -> Result<Option<AppUser>, String> {
    conn.query_row(
        "SELECT id,name,role,enabled,created_at,(pin_hash IS NOT NULL AND pin_hash!='') FROM users WHERE id=?1",
        params![id],
        |row| {
            Ok(AppUser {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                pin_enabled: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub(crate) fn users_list_internal(conn: &Connection) -> Result<Vec<AppUser>, String> {
    let mut statement = conn
        .prepare("SELECT id,name,role,enabled,created_at,(pin_hash IS NOT NULL AND pin_hash!='') FROM users ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(AppUser {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                pin_enabled: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn hash_password(password: &str) -> Result<String, String> {
    validate_password(password)?;
    let salt = random_bytes::<16>()?;
    let hash = pbkdf2_sha256(password.as_bytes(), &salt, PASSWORD_ITERATIONS)?;
    Ok(format!(
        "pbkdf2-sha256${}${}${}",
        PASSWORD_ITERATIONS,
        hex::encode(salt),
        hex::encode(hash)
    ))
}

pub(crate) fn verify_password(password: &str, encoded: &str) -> bool {
    let parts: Vec<_> = encoded.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    if !(100_000..=1_000_000).contains(&iterations) {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (hex::decode(parts[2]), hex::decode(parts[3])) else {
        return false;
    };
    if salt.len() < 16 || expected.len() != 32 {
        return false;
    }
    let Ok(actual) = pbkdf2_sha256(password.as_bytes(), &salt, iterations) else {
        return false;
    };
    bool::from(actual.as_slice().ct_eq(expected.as_slice()))
}

pub(crate) fn pin_material(pin: &str) -> Vec<u8> {
    let mut value = b"KlipperFarmPIN\0".to_vec();
    value.extend_from_slice(pin.as_bytes());
    value
}

pub(crate) fn hash_pin(pin: &str) -> Result<String, String> {
    validate_pin(pin)?;
    let salt = random_bytes::<16>()?;
    let hash = pbkdf2_sha256(&pin_material(pin), &salt, PIN_ITERATIONS)?;
    Ok(format!(
        "pbkdf2-sha256-pin${}${}${}",
        PIN_ITERATIONS,
        hex::encode(salt),
        hex::encode(hash)
    ))
}

pub(crate) fn verify_pin(pin: &str, encoded: &str) -> bool {
    if validate_pin(pin).is_err() {
        return false;
    }
    let parts: Vec<_> = encoded.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256-pin" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    if !(100_000..=1_000_000).contains(&iterations) {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (hex::decode(parts[2]), hex::decode(parts[3])) else {
        return false;
    };
    if salt.len() < 16 || expected.len() != 32 {
        return false;
    }
    let Ok(actual) = pbkdf2_sha256(&pin_material(pin), &salt, iterations) else {
        return false;
    };
    bool::from(actual.as_slice().ct_eq(expected.as_slice()))
}

pub(crate) fn new_session(auth: &State<'_, AuthState>, user: AppUser) -> Result<AuthSession, String> {
    let token = hex::encode(random_bytes::<32>()?);
    let created_at = now_ms();
    auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?
        .sessions
        .insert(
            token.clone(),
            SessionRecord {
                user_id: user.id.clone(),
                created_at,
                last_seen: created_at,
            },
        );
    Ok(AuthSession { token, user })
}

pub(crate) fn auth_credentials_configured(conn:&Connection)->Result<bool,String>{
    conn.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id='admin' AND (COALESCE(password_hash,'')!='' OR COALESCE(pin_hash,'')!=''))",[],|row|row.get(0)).map_err(|e|e.to_string())
}

#[tauri::command]
pub(crate) fn auth_status(app: AppHandle) -> Result<AuthStatus, String> {
    let conn = open_db(&app)?;
    let configured=auth_credentials_configured(&conn)?;
    Ok(AuthStatus { needs_setup: !configured })
}

#[tauri::command]
pub(crate) async fn auth_bootstrap(
    app: AppHandle,
    auth: State<'_, AuthState>,
    password: String,
    pin: Option<String>,
) -> Result<AuthSession, String> {
    let (hash, pin_hash) = bounded_spawn_blocking(ExecutionClass::Control, move || {
        let hash = if password.is_empty() { None } else { Some(hash_password(&password)?) };
        let pin_hash = pin
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(hash_pin)
            .transpose()?;
        if hash.is_none() && pin_hash.is_none() { return Err("Задайте пароль или PIN-код".into()); }
        Ok::<_, String>((hash, pin_hash))
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))??;
    let conn = open_db(&app)?;
    let changed = conn
        .execute(
            BOOTSTRAP_CREDENTIALS_SQL,
            params![hash, pin_hash],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Первичная настройка уже выполнена".into());
    }
    let user = user_by_id(&conn, "admin")?.ok_or("Профиль администратора не найден")?;
    insert_audit(
        &app,
        "admin",
        "auth.bootstrap",
        "Настроен способ входа администратора",
    )?;
    new_session(&auth, user)
}

pub(crate) async fn auth_login_internal(
    app: AppHandle,
    auth: State<'_, AuthState>,
    user_id: String,
    credential: String,
    pin_mode: bool,
) -> Result<AuthSession, String> {
    let normalized = user_id.trim().to_lowercase();
    let invalid_message = if pin_mode {
        "Неверное имя пользователя или PIN-код"
    } else {
        "Неверное имя пользователя или пароль"
    };
    if !auth_policy::input_allowed(&normalized, &credential)
        || (pin_mode && validate_pin(&credential).is_err())
    {
        return Err(invalid_message.into());
    }
    {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Состояние авторизации недоступно")?;
        let mut book = auth_policy::FailureBook {
            failures: std::mem::take(&mut inner.failures),
            global: std::mem::take(&mut inner.global_failures),
        };
        let locked = auth_policy::begin_attempt(&mut book, &normalized, now_ms());
        inner.failures = book.failures;
        inner.global_failures = book.global;
        drop(inner);
        if let Some(reason) = locked {
            return Err(reason.into());
        }
    }
    let conn = open_db(&app)?;
    let row = auth_policy::lookup_user(&conn, &normalized)?;
    drop(conn);
    let encoded_hash = row.as_ref().and_then(|(_, password_hash, pin_hash)| {
        if pin_mode {
            pin_hash.clone()
        } else {
            password_hash.clone()
        }
    });
    let hash_valid = bounded_spawn_blocking(ExecutionClass::Control, move || {
        match encoded_hash.as_deref() {
            Some(value) if pin_mode => verify_pin(&credential, value),
            Some(value) => verify_password(&credential, value),
            None => {
                let material = if pin_mode {
                    pin_material(&credential)
                } else {
                    credential.as_bytes().to_vec()
                };
                let _ = pbkdf2_sha256(&material, b"KlipperFarmDummy", PASSWORD_ITERATIONS);
                false
            }
        }
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))?;
    let decision = auth_policy::decide(&normalized, row.as_ref(), hash_valid, pin_mode);
    let outcome = {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Состояние авторизации недоступно")?;
        let mut book = auth_policy::FailureBook {
            failures: std::mem::take(&mut inner.failures),
            global: std::mem::take(&mut inner.global_failures),
        };
        let outcome = auth_policy::finish_attempt(&mut book, &normalized, &decision, now_ms());
        inner.failures = book.failures;
        inner.global_failures = book.global;
        outcome
    };
    match outcome {
        auth_policy::Attempt::Allowed => {
            let auth_policy::LoginDecision::Accepted { user, audit_action, audit_details } = decision else {
                return Err(invalid_message.into());
            };
            insert_audit(&app, &user.id, audit_action, audit_details)?;
            new_session(&auth, user)
        }
        auth_policy::Attempt::Refused(reason) => {
            // След в аудите: сбой записи не должен подменять причину отказа.
            if let Err(error) = insert_audit(
                &app,
                &normalized,
                if pin_mode { "auth.pin_failed" } else { "auth.failed" },
                "Неуспешная попытка входа",
            ) {
                crate::observability::record(
                    "error",
                    "audit",
                    "AUTH_FAILURE_AUDIT_WRITE_FAILED",
                    None,
                    "Неуспешная попытка входа не записана в журнал аудита",
                    serde_json::json!({"error": error}),
                );
            }
            Err(reason)
        }
    }
}

#[tauri::command]
pub(crate) async fn auth_login(
    app: AppHandle,
    auth: State<'_, AuthState>,
    user_id: String,
    password: String,
) -> Result<AuthSession, String> {
    auth_login_internal(app, auth, user_id, password, false).await
}

#[tauri::command]
pub(crate) async fn auth_pin_login(
    app: AppHandle,
    auth: State<'_, AuthState>,
    user_id: String,
    pin: String,
) -> Result<AuthSession, String> {
    auth_login_internal(app, auth, user_id, pin, true).await
}

pub(crate) fn hello_entry(id:&str)->Result<keyring::Entry,String>{
    validate_user_id(id)?;
    keyring::Entry::new("KlipperFarm.WindowsHello.v1",id).map_err(|_|"Хранилище доступа Windows недоступно".into())
}

pub(crate) fn hello_grant(id:&str)->Result<Option<HelloGrant>,String>{
    match hello_entry(id)?.get_password(){
        Ok(value) if value.len()<=1024 => serde_json::from_str(&value).map(Some).map_err(|_|"Повторно настройте Windows Hello в настройках входа".into()),
        Ok(_) => Err("Запись Windows Hello повреждена".into()),
        Err(keyring::Error::NoEntry)=>Ok(None),
        Err(_)=>Err("Хранилище доступа Windows недоступно".into()),
    }
}

pub(crate) fn hello_user_stamp(app:&AppHandle,id:&str)->Result<(AppUser,String),String>{
    validate_user_id(id)?;
    let conn=open_db(app)?;
    let user=user_by_id(&conn,id)?.filter(|u|u.enabled).ok_or("Вход для этого пользователя недоступен")?;
    let hashes:(Option<String>,Option<String>)=conn.query_row("SELECT password_hash,pin_hash FROM users WHERE id=?1",params![id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if hashes.0.as_deref().unwrap_or("").is_empty() && hashes.1.as_deref().unwrap_or("").is_empty(){return Err("Сначала настройте пароль или PIN-код".into());}
    let material=serde_json::to_vec(&(&user.id,&user.role,user.created_at,hashes)).map_err(|e|e.to_string())?;
    Ok((user,hex::encode(Sha256::digest(material))))
}

pub(crate) fn hello_grant_matches(grant:&HelloGrant,id:&str,stamp:&str)->bool{
    grant.version==1 && grant.user_id==id && grant.credential_stamp.len()==64 && bool::from(grant.credential_stamp.as_bytes().ct_eq(stamp.as_bytes()))
}

pub(crate) async fn hello_verify(window:&tauri::WebviewWindow,auth:&State<'_,AuthState>,message:String)->Result<(),String>{
    #[cfg(windows)]
    let hwnd=window.hwnd().map_err(|_|"Окно программы недоступно")?.0 as isize;
    #[cfg(not(windows))]
    let hwnd={let _=window;0isize};
    if auth.hello_busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err("Windows Hello уже ожидает подтверждения".into());}
    let guard=HelloBusy(auth.hello_busy.clone());
    bounded_spawn_blocking(ExecutionClass::Control,move||{let _guard=guard;windows_hello::verify(hwnd,&message)}).await.map_err(|_|"Windows Hello не удалось запустить".to_string())?
}

#[tauri::command]
pub(crate) async fn auth_hello_status(app:AppHandle,user_id:String)->Result<HelloStatus,String>{
    let id=user_id.trim().to_lowercase();validate_user_id(&id)?;
    let available=bounded_spawn_blocking(ExecutionClass::Control,windows_hello::available).await.map_err(|_|"Проверка Windows Hello недоступна")??;
    if !available{return Ok(HelloStatus{available:false,enrolled:false,detail:"Настройте Windows Hello в параметрах входа Windows 11".into()});}
    let enrolled=match (hello_user_stamp(&app,&id),hello_grant(&id)) { (Ok((_,stamp)),Ok(Some(grant)))=>hello_grant_matches(&grant,&id,&stamp),(_,Err(e))=>return Err(e),_=>false };
    Ok(HelloStatus{available:true,enrolled,detail:if enrolled{"Windows Hello подключён"}else{"Войдите по PIN или паролю и включите Windows Hello в настройках"}.into()})
}

#[tauri::command]
pub(crate) async fn auth_hello_enable(app:AppHandle,window:tauri::WebviewWindow,auth:State<'_,AuthState>,session_token:String)->Result<(),String>{
    let user=require_role(&app,&auth,&session_token,Role::Viewer)?;
    let (_,stamp)=hello_user_stamp(&app,&user.id)?;
    hello_verify(&window,&auth,format!("Klipper Farm: подключить Windows Hello для {}",user.name)).await?;
    let current=require_role(&app,&auth,&session_token,Role::Viewer)?;
    let (_,fresh)=hello_user_stamp(&app,&current.id)?;
    if current.id!=user.id || fresh!=stamp {return Err("Доступ изменился. Войдите заново и повторите настройку".into());}
    let record=serde_json::to_string(&HelloGrant{version:1,user_id:user.id.clone(),credential_stamp:stamp}).map_err(|e|e.to_string())?;
    hello_entry(&user.id)?.set_password(&record).map_err(|_|"Не удалось сохранить доступ в Windows".to_string())?;
    insert_audit(&app,&user.id,"auth.hello_enable","Windows Hello подключён на этом ПК")
}

#[tauri::command]
pub(crate) fn auth_hello_disable(app:AppHandle,auth:State<'_,AuthState>,session_token:String)->Result<(),String>{
    let user=require_role(&app,&auth,&session_token,Role::Viewer)?;
    match hello_entry(&user.id)?.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>{},Err(_)=>return Err("Не удалось отключить Windows Hello".into())}
    insert_audit(&app,&user.id,"auth.hello_disable","Windows Hello отключён на этом ПК")
}

#[tauri::command]
pub(crate) async fn auth_hello_login(app:AppHandle,window:tauri::WebviewWindow,auth:State<'_,AuthState>,user_id:String)->Result<AuthSession,String>{
    let id=user_id.trim().to_lowercase();
    let (_,stamp)=hello_user_stamp(&app,&id)?;
    let grant=hello_grant(&id)?.ok_or("Сначала подключите Windows Hello в настройках входа")?;
    if !hello_grant_matches(&grant,&id,&stamp){return Err("Доступ изменился. Войдите по PIN или паролю и подключите Windows Hello заново".into());}
    hello_verify(&window,&auth,"Klipper Farm: подтвердите вход".into()).await?;
    let (user,fresh)=hello_user_stamp(&app,&id)?;
    let current=hello_grant(&id)?.ok_or("Windows Hello отключён во время проверки")?;
    if fresh!=stamp || !hello_grant_matches(&current,&id,&fresh){return Err("Доступ изменился во время проверки. Войдите другим способом".into());}
    insert_audit(&app,&id,"auth.hello_login","Вход подтверждён Windows Hello")?;
    new_session(&auth,user)
}

#[tauri::command]
pub(crate) fn auth_logout(auth: State<'_, AuthState>, session_token: String) -> Result<(), String> {
    auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?
        .sessions
        .remove(&session_token);
    Ok(())
}

#[tauri::command]
pub(crate) async fn auth_change_password(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    let current_hash: Option<String> = {
        let conn = open_db(&app)?;
        conn.query_row(
                "SELECT password_hash FROM users WHERE id=?1",
                params![user.id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?
    };
    let new_hash = bounded_spawn_blocking(ExecutionClass::Control, move || {
        if !current_hash
            .as_deref()
            .is_some_and(|value| verify_password(&current_password, value))
        {
            return Err("Текущий пароль неверен".to_string());
        }
        hash_password(&new_password)
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))??;
    open_db(&app)?.execute(
        "UPDATE users SET password_hash=?1 WHERE id=?2",
        params![new_hash, user.id],
    )
    .map_err(|e| e.to_string())?;
    let mut inner = auth
        .inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?;
    inner
        .sessions
        .retain(|token, record| token == &session_token || record.user_id != user.id);
    drop(inner);
    insert_audit(&app, &user.id, "auth.password_changed", "Пароль изменён")
}

#[tauri::command]
pub(crate) fn users_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
) -> Result<Vec<AppUser>, String> {
    require_role(&app, &auth, &session_token, Role::Admin)?;
    users_list_internal(&open_db(&app)?)
}

pub(crate) fn validate_user_id(id: &str) -> Result<(), String> {
    if !(3..=64).contains(&id.len())
        || !id.bytes().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || b"._-".contains(&value)
        })
    {
        return Err("ID пользователя: 3–64 символа a-z, 0-9, '.', '_' или '-'".into());
    }
    Ok(())
}

pub(crate) fn ensure_pin_removal_keeps_access(conn:&Connection,id:&str,clear_pin:bool,new_password:bool)->Result<(),String>{
    if clear_pin && !new_password {
        let has_password:bool=conn.query_row("SELECT COALESCE(password_hash,'')!='' FROM users WHERE id=?1",params![id],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !has_password {return Err("Сначала задайте пароль: нельзя удалить единственный способ входа".into());}
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn user_save(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    user: UserInput,
) -> Result<(), String> {
    let actor = require_role(&app, &auth, &session_token, Role::Admin)?;
    let id = user.id.trim().to_lowercase();
    // Проверки, которые решаются по значениям, живут в auth_policy и проверяются
    // там же тестами; здесь остаётся только чтение «было ли раньше».
    let previous: Option<(String, bool)> = {
        let conn = open_db(&app)?;
        conn.query_row(
                "SELECT role,enabled FROM users WHERE id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(|e| e.to_string())?
    };
    let exists = previous.is_some();
    let checked = auth_policy::validate_user(&user, exists)?;
    let id = checked.id;
    let name = checked.name.as_str();
    let password = user.password.clone();
    let pin = user.pin.clone();
    let (password_hash, pin_hash) = bounded_spawn_blocking(ExecutionClass::Control, move || {
        let password_hash = password
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(hash_password)
            .transpose()?;
        let pin_hash = pin
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(hash_pin)
            .transpose()?;
        Ok::<_, String>((password_hash, pin_hash))
    })
    .await
    .map_err(|error| format!("Password worker failed: {error}"))??;
    let credentials_changed = password_hash.is_some() || user.clear_pin || pin_hash.is_some();
    let mut conn = open_db(&app)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    if exists { ensure_pin_removal_keeps_access(&transaction,&id,user.clear_pin,password_hash.is_some())?; }
    if exists {
        transaction
            .execute(
                "UPDATE users SET
                     name=?1,role=?2,enabled=?3,
                     password_hash=COALESCE(?4,password_hash),
                     pin_hash=CASE WHEN ?5=1 THEN NULL ELSE COALESCE(?6,pin_hash) END
                 WHERE id=?7",
                params![
                    name,
                    &user.role,
                    if user.enabled { 1 } else { 0 },
                    password_hash.as_deref(),
                    if user.clear_pin { 1 } else { 0 },
                    pin_hash.as_deref(),
                    &id
                ],
            )
            .map_err(|e| e.to_string())?;
    } else {
        transaction
            .execute(
                "INSERT INTO users(id,name,role,enabled,created_at,password_hash,pin_hash) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![&id, name, &user.role, if user.enabled { 1 } else { 0 }, user.created_at.max(1), password_hash.as_deref(), pin_hash.as_deref()],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    if auth_policy::sessions_must_be_revoked(previous.as_ref(), &user.role, user.enabled, credentials_changed) {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Состояние авторизации недоступно")?;
        revoke_user_sessions(&mut inner, &id);
    }
    insert_audit(
        &app,
        &actor.id,
        if exists { "user.update" } else { "user.create" },
        &id,
    )
}

pub(crate) fn revoke_user_sessions(inner: &mut AuthInner, user_id: &str) {
    inner
        .sessions
        .retain(|_, record| record.user_id != user_id);
}

#[tauri::command]
pub(crate) fn user_delete(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    id: String,
) -> Result<(), String> {
    let actor = require_role(&app, &auth, &session_token, Role::Admin)?;
    let id = id.trim().to_lowercase();
    if id == "admin" || id == actor.id {
        return Err("Нельзя удалить встроенного или текущего пользователя".into());
    }
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM users WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    let mut inner = auth.inner
        .lock()
        .map_err(|_| "Состояние авторизации недоступно")?;
    revoke_user_sessions(&mut inner, &id);
    drop(inner);
    insert_audit(&app, &actor.id, "user.delete", &id)
}

pub(crate) fn require_role(
    app: &AppHandle,
    auth: &State<'_, AuthState>,
    session_token: &str,
    minimum: Role,
) -> Result<AppUser, String> {
    if app.try_state::<online_updates::UpdateState>().is_some_and(|state| state.applying.load(Ordering::SeqCst)) {
        return Err("UPDATING: приложение готовится к перезапуску; новые операции временно отложены".into());
    }
    if session_token.len() != 64 || !session_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("AUTH_REQUIRED: требуется вход".into());
    }
    let user_id = {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "AUTH_REQUIRED: состояние авторизации недоступно")?;
        let Some(record) = inner.sessions.get(session_token).cloned() else {
            return Err("AUTH_REQUIRED: сессия недействительна".into());
        };
        let now = now_ms();
        if now.saturating_sub(record.last_seen) > SESSION_IDLE_MS
            || now.saturating_sub(record.created_at) > SESSION_ABSOLUTE_MS
        {
            inner.sessions.remove(session_token);
            return Err("AUTH_REQUIRED: сессия истекла".into());
        }
        if let Some(record) = inner.sessions.get_mut(session_token) {
            record.last_seen = now;
        }
        record.user_id.clone()
    };
    let conn = open_db(app)?;
    let user = user_by_id(&conn, &user_id)?.ok_or("AUTH_REQUIRED: пользователь не найден")?;
    if !user.enabled {
        return Err("AUTH_REQUIRED: пользователь отключён".into());
    }
    if parse_role(&user.role)? < minimum {
        return Err("FORBIDDEN: недостаточно прав".into());
    }
    Ok(user)
}

pub(crate) fn validate_password(password: &str) -> Result<(), String> {
    let length = password.chars().count();
    if !(12..=128).contains(&length) {
        return Err("Пароль должен содержать от 12 до 128 символов".into());
    }
    if password.chars().any(char::is_control) {
        return Err("Пароль содержит недопустимые управляющие символы".into());
    }
    let classes = [
        password.chars().any(char::is_lowercase),
        password.chars().any(char::is_uppercase),
        password.chars().any(|value| value.is_ascii_digit()),
        password
            .chars()
            .any(|value| !value.is_alphanumeric() && !value.is_whitespace()),
    ]
    .into_iter()
    .filter(|value| *value)
    .count();
    if classes < 3 {
        return Err(
            "Используйте минимум три типа символов: строчные, прописные, цифры и знаки".into(),
        );
    }
    Ok(())
}

pub(crate) fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> Result<[u8; 32], String> {
    let mut mac = HmacSha256::new_from_slice(password).map_err(|_| "Ошибка хеширования пароля")?;
    mac.update(salt);
    mac.update(&1_u32.to_be_bytes());
    let mut previous = mac.finalize().into_bytes();
    let mut output = previous;
    for _ in 1..iterations {
        let mut round =
            HmacSha256::new_from_slice(password).map_err(|_| "Ошибка хеширования пароля")?;
        round.update(&previous);
        previous = round.finalize().into_bytes();
        for (target, value) in output.iter_mut().zip(previous.iter()) {
            *target ^= *value;
        }
    }
    let mut result = [0_u8; 32];
    result.copy_from_slice(&output);
    Ok(result)
}

pub(crate) fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"._:-".contains(&value))
    {
        return Err("Недопустимый ключ данных".into());
    }
    Ok(())
}
