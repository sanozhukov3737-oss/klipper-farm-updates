//! Решение о входе: пускать или нет.
//!
//! Здесь нет Tauri: ни `AppHandle`, ни `State`. Только база, состояние счётчиков
//! и данные, которые пришли от пользователя. Это позволяет проверить вход
//! целиком — включая ограничение частоты попыток — не поднимая приложение.
//!
//! Обвязка (открыть базу, записать аудит, создать сессию) осталась в команде.

use rusqlite::{params, Connection, OptionalExtension};

use crate::{FailureRecord, Role, FAILURE_RECORD_TTL_MS, GLOBAL_FAILURE_LIMIT, MAX_FAILURE_RECORDS};

/// Что решили. Ошибка — это отказ, и текст важен: он не должен подсказывать,
/// существует ли такая учётная запись.
pub(crate) enum LoginDecision {
    Rejected(String),
    Accepted {
        user: crate::AppUser,
        /// Что записать в аудит: действие и описание.
        audit_action: &'static str,
        audit_details: &'static str,
    },
}

/// Счётчики неудачных попыток. Живут в состоянии приложения, но правила
/// целиком здесь.
#[derive(Default)]
pub(crate) struct FailureBook {
    pub failures: std::collections::HashMap<String, FailureRecord>,
    pub global: FailureRecord,
}

impl FailureBook {
    /// Убирает просроченные записи. Без этого таблица счётчиков растёт от
    /// каждого опечатанного пароля и никогда не чистится.
    pub fn expire(&mut self, now: i64) {
        self.failures.retain(|_, failure| {
            failure.locked_until > now || now.saturating_sub(failure.last_seen) <= FAILURE_RECORD_TTL_MS
        });
        if now.saturating_sub(self.global.last_seen) > FAILURE_RECORD_TTL_MS {
            self.global = FailureRecord::default();
        }
    }

    /// Причина отказа, если вход сейчас запрещён. `None` — можно пробовать.
    pub fn lock_reason(&self, user_id: &str, now: i64) -> Option<&'static str> {
        if self.global.locked_until > now {
            return Some("Слишком много попыток входа. Повторите через минуту");
        }
        if self
            .failures
            .get(user_id)
            .is_some_and(|failure| failure.locked_until > now)
        {
            return Some("Слишком много попыток. Повторите вход через несколько минут");
        }
        None
    }

    /// Учитывает неудачу: счётчик пользователя и общий.
    pub fn record_failure(&mut self, user_id: &str, now: i64) {
        // Таблица счётчиков обязана быть ограничена: иначе перебор имён
        // пользователей превращается в рост памяти.
        if !self.failures.contains_key(user_id) && self.failures.len() >= MAX_FAILURE_RECORDS {
            if let Some(oldest) = self
                .failures
                .iter()
                .min_by_key(|(_, failure)| failure.last_seen)
                .map(|(id, _)| id.clone())
            {
                self.failures.remove(&oldest);
            }
        }
        let failure = self.failures.entry(user_id.to_string()).or_default();
        failure.count = failure.count.saturating_add(1);
        failure.last_seen = now;
        if failure.count >= 5 {
            failure.locked_until = now + 5 * 60 * 1000;
            failure.count = 0;
        }
        self.global.count = self.global.count.saturating_add(1);
        self.global.last_seen = now;
        if self.global.count >= GLOBAL_FAILURE_LIMIT {
            self.global.locked_until = now + 60 * 1000;
            self.global.count = 0;
        }
    }

    /// Успешный вход снимает счётчик этого пользователя.
    pub fn clear_failure(&mut self, user_id: &str) {
        self.failures.remove(user_id);
    }
}

/// Читает учётную запись и её хеши. Отдельно, чтобы вызывающий мог решить,
/// когда именно идти в базу.
pub(crate) fn lookup_user(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<(crate::AppUser, Option<String>, Option<String>)>, String> {
    conn.query_row(
        "SELECT id,name,role,enabled,created_at,password_hash,pin_hash FROM users WHERE id=?1",
        params![user_id],
        |row| {
            let pin_hash: Option<String> = row.get(6)?;
            Ok((
                crate::AppUser {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    role: row.get(2)?,
                    enabled: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                    pin_enabled: pin_hash.as_deref().is_some_and(|value| !value.is_empty()),
                },
                row.get(5)?,
                pin_hash,
            ))
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Допустимая длина того, что пришло от пользователя. Проверяется до базы и до
/// хеширования: иначе перебор длинных строк стоит дороже нужного.
pub(crate) fn input_allowed(user_id: &str, credential: &str) -> bool {
    !user_id.is_empty() && user_id.len() <= 64 && credential.len() <= 512
}

/// Итоговое решение по уже прочитанной записи и проверенному хешу.
///
/// Отдельная функция, потому что это единственное место, где решается «пускать»,
/// и его надо проверять без базы и без Tauri.
pub(crate) fn decide(
    user_id: &str,
    row: Option<&(crate::AppUser, Option<String>, Option<String>)>,
    hash_valid: bool,
    pin_mode: bool,
) -> LoginDecision {
    let invalid = if pin_mode {
        "Неверное имя пользователя или PIN-код"
    } else {
        "Неверное имя пользователя или пароль"
    };
    let Some((user, _, _)) = row else {
        return LoginDecision::Rejected(invalid.to_string());
    };
    // Отключённый пользователь получает тот же текст, что и несуществующий:
    // иначе по сообщению можно перечислить учётные записи.
    if !user.enabled || !hash_valid || user.id != user_id {
        return LoginDecision::Rejected(invalid.to_string());
    }
    LoginDecision::Accepted {
        user: user.clone(),
        audit_action: if pin_mode { "auth.pin_login" } else { "auth.login" },
        audit_details: if pin_mode { "Вход по PIN-коду" } else { "Вход выполнен" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppUser;

    fn user(id: &str, enabled: bool) -> AppUser {
        AppUser { id: id.into(), name: id.into(), role: "admin".into(), enabled, created_at: 0, pin_enabled: false }
    }
    fn row(id: &str, enabled: bool) -> (AppUser, Option<String>, Option<String>) {
        (user(id, enabled), Some("hash".into()), None)
    }

    #[test]
    fn верный_пароль_действующего_пользователя_пускает() {
        let r = row("admin", true);
        match decide("admin", Some(&r), true, false) {
            LoginDecision::Accepted { user, audit_action, .. } => {
                assert_eq!(user.id, "admin");
                assert_eq!(audit_action, "auth.login");
            }
            LoginDecision::Rejected(reason) => panic!("отказ: {reason}"),
        }
    }

    #[test]
    fn вход_по_pin_пишется_отдельным_действием() {
        let r = row("admin", true);
        match decide("admin", Some(&r), true, true) {
            LoginDecision::Accepted { audit_action, .. } => assert_eq!(audit_action, "auth.pin_login"),
            LoginDecision::Rejected(reason) => panic!("отказ: {reason}"),
        }
    }

    #[test]
    fn неверный_хеш_отказ_без_подсказок() {
        let r = row("admin", true);
        for pin_mode in [false, true] {
            match decide("admin", Some(&r), false, pin_mode) {
                LoginDecision::Rejected(reason) => assert!(reason.contains("Неверное имя пользователя"), "{reason}"),
                LoginDecision::Accepted { .. } => panic!("пустил с неверным хешем"),
            }
        }
    }

    #[test]
    fn отсутствующий_и_отключённый_дают_тот_же_текст() {
        let absent = decide("admin", None, true, false);
        let disabled_row = row("admin", false);
        let disabled = decide("admin", Some(&disabled_row), true, false);
        let (LoginDecision::Rejected(a), LoginDecision::Rejected(b)) = (absent, disabled) else {
            panic!("отключённый или отсутствующий пользователь не отвергнут");
        };
        // Одинаковый текст — иначе вход работает как перечисление учётных записей.
        assert_eq!(a, b);
    }

    #[test]
    fn строка_другого_пользователя_не_принимается() {
        let r = row("operator", true);
        match decide("admin", Some(&r), true, false) {
            LoginDecision::Rejected(_) => {}
            LoginDecision::Accepted { .. } => panic!("принята чужая учётная запись"),
        }
    }

    #[test]
    fn длины_входа_ограничены() {
        assert!(input_allowed("admin", "KlipperFarm-2026!"));
        assert!(!input_allowed("", "KlipperFarm-2026!"));
        assert!(!input_allowed(&"u".repeat(65), "x"));
        assert!(!input_allowed("admin", &"x".repeat(513)));
        assert!(input_allowed("admin", &"x".repeat(512)));
    }

    #[test]
    fn пятая_неудача_блокирует_на_пять_минут() {
        let mut book = FailureBook::default();
        let t0 = 1_000_000;
        for i in 0..4 {
            book.record_failure("admin", t0 + i);
            assert!(book.lock_reason("admin", t0 + i).is_none(), "блокировка после {i} попыток");
        }
        book.record_failure("admin", t0 + 10);
        assert!(book.lock_reason("admin", t0 + 10).is_some(), "пятая неудача не заблокировала");
        // Счётчик сброшен: следующая серия начинается заново.
        assert_eq!(book.failures.get("admin").unwrap().count, 0);
    }

    #[test]
    fn блокировка_истекает_и_снимается_успехом() {
        let mut book = FailureBook::default();
        for i in 0..5 {
            book.record_failure("admin", 1_000 + i);
        }
        let locked_until = book.failures.get("admin").unwrap().locked_until;
        assert!(book.lock_reason("admin", locked_until - 1).is_some());
        assert!(book.lock_reason("admin", locked_until + 1).is_none(), "блокировка не истекла");
        book.clear_failure("admin");
        assert!(book.lock_reason("admin", locked_until - 1).is_none(), "успешный вход не снял блокировку");
    }

    #[test]
    fn общая_блокировка_перебора_срабатывает_по_разным_именам() {
        let mut book = FailureBook::default();
        // Перебор имён пользователей: счётчик каждого в отдельности мал, а общий растёт.
        for n in 0..(crate::GLOBAL_FAILURE_LIMIT + 1) {
            book.record_failure(&format!("user-{n}"), 1_000 + n as i64);
        }
        assert!(book.lock_reason("кто-угодно", 2_000).is_some(), "общая блокировка не сработала");
    }

    #[test]
    fn таблица_счётчиков_не_растёт_бесконечно() {
        let mut book = FailureBook::default();
        for n in 0..(crate::MAX_FAILURE_RECORDS + 50) {
            book.record_failure(&format!("user-{n}"), 1_000 + n as i64);
        }
        assert!(
            book.failures.len() <= crate::MAX_FAILURE_RECORDS,
            "таблица выросла до {} при пределе {}",
            book.failures.len(),
            crate::MAX_FAILURE_RECORDS
        );
    }

    #[test]
    fn просроченные_записи_удаляются() {
        let mut book = FailureBook::default();
        book.record_failure("старый", 1_000);
        assert_eq!(book.failures.len(), 1);
        let later = 1_000 + crate::FAILURE_RECORD_TTL_MS + 1;
        book.expire(later);
        assert!(book.failures.is_empty(), "просроченная запись осталась");
        assert_eq!(book.global.count, 0, "общий счётчик не сброшен");
    }
}

/// Проверка данных пользователя до любой записи. Всё, что можно решить по
/// значениям, решается здесь — база и Tauri для этого не нужны.
pub(crate) fn validate_user(user: &crate::UserInput, exists: bool) -> Result<ValidatedUser, String> {
    let id = user.id.trim().to_lowercase();
    crate::validate_user_id(&id)?;
    let name = user.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Имя пользователя должно содержать от 1 до 80 символов".into());
    }
    let role = crate::parse_role(&user.role)?;
    // Встроенного администратора нельзя отключить или понизить: иначе ферма
    // останется без единственной учётной записи с полными правами.
    if id == "admin" && (role != Role::Admin || !user.enabled) {
        return Err("Встроенного администратора нельзя отключить или понизить".into());
    }
    if user.clear_pin && user.pin.as_deref().is_some_and(|value| !value.is_empty()) {
        return Err("Нельзя одновременно задать и удалить PIN-код".into());
    }
    let has_password = user.password.as_deref().is_some_and(|value| !value.is_empty());
    let has_pin = user.pin.as_deref().is_some_and(|value| !value.is_empty());
    if !exists && !has_password && !has_pin {
        return Err("Для нового пользователя требуется пароль или PIN-код".into());
    }
    Ok(ValidatedUser { id, name: name.to_string(), role, has_password })
}

/// Результат проверки: то, что дальше идёт в базу без повторного разбора.
pub(crate) struct ValidatedUser {
    pub id: String,
    pub name: String,
    /// Проверенная роль: в базу пишется она, а не исходная строка, поэтому
    /// опечатка в роли не долетит до записи.
    #[allow(dead_code)] // читается в тестах и при будущей записи role
    pub role: Role,
    /// Признак нужен вызывающему, чтобы понять, менялись ли учётные данные.
    #[allow(dead_code)]
    pub has_password: bool,
}

/// Нужно ли снять сессии после изменения. Права и учётные данные меняются —
/// значит старые сессии больше не отражают действительность.
pub(crate) fn sessions_must_be_revoked(
    previous: Option<&(String, bool)>,
    new_role: &str,
    new_enabled: bool,
    credentials_changed: bool,
) -> bool {
    // Новый пользователь: предыдущей записи нет, снимать нечего. Иначе
    // создание пользователя с паролем отзывало бы сессии по пустому id.
    if previous.is_none() {
        return false;
    }
    let access_changed = previous.is_some_and(|(old_role, old_enabled)| {
        old_role != new_role || *old_enabled != new_enabled
    });
    access_changed || credentials_changed
}

#[cfg(test)]
mod user_tests {
    use super::*;
    use crate::UserInput;

    fn input(id: &str, name: &str, role: &str) -> UserInput {
        UserInput {
            id: id.into(), name: name.into(), role: role.into(), enabled: true,
            created_at: 0, password: Some("KlipperFarm-2026!".into()), pin: None, clear_pin: false,
        }
    }

    #[test]
    fn корректный_пользователь_проходит() {
        let checked = validate_user(&input("operator", "Пётр", "operator"), false).unwrap();
        assert_eq!(checked.id, "operator");
        assert_eq!(checked.name, "Пётр");
        assert!(checked.has_password);
    }

    #[test]
    fn идентификатор_приводится_к_нижнему_регистру() {
        let checked = validate_user(&input("  Operator  ", "Пётр", "operator"), false).unwrap();
        assert_eq!(checked.id, "operator", "регистр или пробелы не нормализованы");
    }

    #[test]
    fn встроенного_администратора_нельзя_отключить_или_понизить() {
        let mut user = input("admin", "Админ", "operator");
        assert!(validate_user(&user, true).is_err(), "понижение admin прошло");
        user.role = "admin".into();
        user.enabled = false;
        assert!(validate_user(&user, true).is_err(), "отключение admin прошло");
        user.enabled = true;
        assert!(validate_user(&user, true).is_ok());
    }

    #[test]
    fn пустое_или_управляющее_имя_отвергается() {
        assert!(validate_user(&input("user1", "", "viewer"), false).is_err());
        assert!(validate_user(&input("user1", "   ", "viewer"), false).is_err());
        assert!(validate_user(&input("user1", &"я".repeat(81), "viewer"), false).is_err());
        assert!(validate_user(&input("user1", "имя\u{0}с", "viewer"), false).is_err());
        assert!(validate_user(&input("user1", &"я".repeat(80), "viewer"), false).is_ok());
    }

    #[test]
    fn нельзя_одновременно_задать_и_удалить_pin() {
        let mut user = input("user1", "Имя", "viewer");
        user.clear_pin = true;
        user.pin = Some("123456".into());
        assert!(validate_user(&user, true).is_err());
    }

    #[test]
    fn новый_пользователь_требует_пароль_или_pin() {
        let mut user = input("user1", "Имя", "viewer");
        user.password = None;
        user.pin = None;
        assert!(validate_user(&user, false).is_err(), "создан пользователь без входа");
        // Существующего можно сохранить без новых учётных данных.
        assert!(validate_user(&user, true).is_ok());
        user.pin = Some("123456".into());
        assert!(validate_user(&user, false).is_ok());
    }

    #[test]
    fn сессии_снимаются_при_смене_прав_и_учётных_данных() {
        let previous = ("viewer".to_string(), true);
        // Сменили роль.
        assert!(sessions_must_be_revoked(Some(&previous), "operator", true, false));
        // Отключили.
        assert!(sessions_must_be_revoked(Some(&previous), "viewer", false, false));
        // Сменили пароль.
        assert!(sessions_must_be_revoked(Some(&previous), "viewer", true, true));
        // Ничего важного не менялось — сессии остаются.
        assert!(!sessions_must_be_revoked(Some(&previous), "viewer", true, false));
        // Новый пользователь: снимать нечего.
        assert!(!sessions_must_be_revoked(None, "viewer", true, true));
    }
}
