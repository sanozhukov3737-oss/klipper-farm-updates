// Local G-code operations retain the original authentication, bounds and transactions.
use super::*;

#[tauri::command]
pub(crate) async fn local_library_list(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
) -> Result<LocalLibraryListResult, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let base = local_library_root(&app)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalLibraryListResult, String> {
            let files = list_local_library_files(&root)?;
            let legacy = list_legacy_local_library_files(&base)?;
            Ok(LocalLibraryListResult {
                files,
                legacy_files: legacy.len(),
                legacy_size: legacy.iter().map(|entry| entry.size).sum(),
            })
        },
    )
    .await
    .map_err(|e| format!("Local library worker failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn local_library_adopt_legacy(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
) -> Result<LocalLibraryAdoptResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    let base = local_library_root(&app)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    let result = bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalLibraryAdoptResult, String> {
            let legacy = list_legacy_local_library_files(&base)?;
            let scoped_root = base.join("by-printer");
            let mut moved = 0;
            let mut skipped = 0;
            for entry in legacy {
                let (_, source) = local_library_file_path(&base, &entry.path)?;
                validate_local_library_parent(
                    &base,
                    source
                        .parent()
                        .ok_or("Не удалось определить старую папку G-code")?,
                )?;
                let source_metadata = fs::symlink_metadata(&source)
                    .map_err(|_| "Старый файл не найден в локальной библиотеке")?;
                if source_metadata.file_type().is_symlink()
                    || !source_metadata.is_file()
                    || source_metadata.len() == 0
                    || source_metadata.len() > MAX_UPLOAD as u64
                {
                    skipped += 1;
                    continue;
                }
                let adopted_path = format!("Старые общие файлы/{}", entry.path);
                let Ok((_, destination)) = local_library_file_path(&root, &adopted_path) else {
                    skipped += 1;
                    continue;
                };
                let parent = destination
                    .parent()
                    .ok_or("Не удалось определить папку переноса G-code")?;
                create_local_library_parent(&root, parent)?;
                if fs::symlink_metadata(&destination).is_ok() {
                    skipped += 1;
                    continue;
                }
                fs::rename(&source, &destination).map_err(|e| e.to_string())?;
                set_private_file_permissions(&destination)?;
                moved += 1;

                let mut current = source.parent();
                while let Some(directory) = current {
                    if directory == base.as_path() || directory == scoped_root.as_path() {
                        break;
                    }
                    if fs::read_dir(directory)
                        .map_err(|e| e.to_string())?
                        .next()
                        .is_some()
                    {
                        break;
                    }
                    let parent = directory.parent();
                    fs::remove_dir(directory).map_err(|e| e.to_string())?;
                    current = parent;
                }
            }
            Ok(LocalLibraryAdoptResult { moved, skipped })
        },
    )
    .await
    .map_err(|e| format!("Local library migration worker failed: {e}"))??;
    insert_audit(
        &app,
        &user.id,
        "local_library.adopt_legacy",
        &format!(
            "{} · {} перенесено · {} пропущено",
            printer_id, result.moved, result.skipped
        ),
    )?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn local_library_merge_scopes(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    source_ids: Vec<String>,
    destination_id: String,
) -> Result<LocalLibraryMergeResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    if source_ids.len() > 64 {
        return Err("За один раз можно объединить не более 64 библиотек".into());
    }
    validate_secret_id(&destination_id)?;
    let destination_root = local_library_printer_root(&app, &destination_id)?;
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for source_id in source_ids {
        validate_secret_id(&source_id)?;
        if source_id == destination_id || !seen.insert(source_id.clone()) {
            continue;
        }
        let scope = local_library_printer_scope(&source_id)?;
        let root = local_library_printer_root(&app, &source_id)?;
        if root != destination_root {
            sources.push((scope, root));
        }
    }
    let source_count = sources.len();
    let result = bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalLibraryMergeResult, String> {
            let mut result = LocalLibraryMergeResult {
                moved: 0,
                renamed: 0,
                duplicates: 0,
                conflicts: 0,
            };
            for (source_scope, source_root) in sources {
                for entry in list_local_library_files(&source_root)? {
                    let (_, source) = local_library_file_path(&source_root, &entry.path)?;
                    let source_parent = source
                        .parent()
                        .ok_or("Не удалось определить исходную папку G-code")?;
                    validate_local_library_parent(&source_root, source_parent)?;
                    let source_metadata = fs::symlink_metadata(&source)
                        .map_err(|_| "Исходный G-code исчез во время объединения")?;
                    if source_metadata.file_type().is_symlink()
                        || !source_metadata.is_file()
                        || source_metadata.len() == 0
                        || source_metadata.len() > MAX_UPLOAD as u64
                    {
                        result.conflicts += 1;
                        continue;
                    }

                    let (_, mut destination) =
                        local_library_file_path(&destination_root, &entry.path)?;
                    let mut renamed = false;
                    if let Ok(metadata) = fs::symlink_metadata(&destination) {
                        if metadata.file_type().is_symlink() || !metadata.is_file() {
                            return Err("Путь общей библиотеки занят небезопасным объектом".into());
                        }
                        if local_library_files_equal(&source, &destination)? {
                            fs::remove_file(&source).map_err(|e| e.to_string())?;
                            let _ =
                                prune_empty_local_library_parents(&source_root, source.parent());
                            result.duplicates += 1;
                            continue;
                        }
                        let alternate = format!(
                            "Объединено из другого принтера/{}/{}",
                            &source_scope[..12],
                            entry.path
                        );
                        destination = local_library_file_path(&destination_root, &alternate)?.1;
                        renamed = true;
                        if let Ok(alternate_metadata) = fs::symlink_metadata(&destination) {
                            if alternate_metadata.file_type().is_symlink()
                                || !alternate_metadata.is_file()
                            {
                                return Err(
                                    "Резервный путь общей библиотеки занят небезопасным объектом"
                                        .into(),
                                );
                            }
                            if local_library_files_equal(&source, &destination)? {
                                fs::remove_file(&source).map_err(|e| e.to_string())?;
                                let _ = prune_empty_local_library_parents(
                                    &source_root,
                                    source.parent(),
                                );
                                result.duplicates += 1;
                            } else {
                                result.conflicts += 1;
                            }
                            continue;
                        }
                    }

                    let destination_parent = destination
                        .parent()
                        .ok_or("Не удалось определить общую папку G-code")?;
                    create_local_library_parent(&destination_root, destination_parent)?;
                    fs::rename(&source, &destination).map_err(|e| e.to_string())?;
                    set_private_file_permissions(&destination)?;
                    let _ = prune_empty_local_library_parents(&source_root, source.parent());
                    result.moved += 1;
                    if renamed {
                        result.renamed += 1;
                    }
                }
            }
            Ok(result)
        },
    )
    .await
    .map_err(|e| format!("Local library merge worker failed: {e}"))??;
    if result.moved + result.duplicates + result.conflicts > 0 {
        insert_audit(
            &app,
            &user.id,
            "local_library.merge_scopes",
            &format!(
                "{} · {} sources · {} moved · {} renamed · {} duplicates · {} conflicts",
                destination_id,
                source_count,
                result.moved,
                result.renamed,
                result.duplicates,
                result.conflicts
            ),
        )?;
    }
    Ok(result)
}

fn prune_expired_local_imports(items: &mut HashMap<String, LocalImportSession>) {
    let expired: Vec<String> = items
        .iter()
        .filter(|(_, session)| session.started.elapsed() >= UPLOAD_SESSION_TTL)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        if let Some(session) = items.remove(&id) {
            let temporary = session.temporary.clone();
            drop(session);
            let _ = fs::remove_file(temporary);
        }
    }
}

fn finish_local_import(session: LocalImportSession) -> Result<LocalLibraryImportResult, String> {
    if let Err(error) = session.file.sync_all() {
        let temporary = session.temporary.clone();
        drop(session);
        let _ = fs::remove_file(temporary);
        return Err(error.to_string());
    }
    drop(session.file);
    let parent = session
        .destination
        .parent()
        .ok_or("Не удалось определить папку локальной библиотеки")?;
    validate_local_library_parent(&session.root, parent)?;
    let existed = match fs::symlink_metadata(&session.destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                let _ = fs::remove_file(&session.temporary);
                return Err("Путь локальной библиотеки занят небезопасным объектом".into());
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = fs::remove_file(&session.temporary);
            return Err(error.to_string());
        }
    };
    if existed && !session.overwrite {
        let size = fs::symlink_metadata(&session.destination)
            .map_err(|error| error.to_string())?
            .len();
        let _ = fs::remove_file(&session.temporary);
        return Ok(LocalLibraryImportResult {
            path: session.relative,
            size,
            status: "skipped".into(),
        });
    }
    if existed {
        let backup = parent.join(format!(
            ".klipper-farm-backup-{}.tmp",
            hex::encode(random_bytes::<12>()?)
        ));
        fs::rename(&session.destination, &backup).map_err(|error| {
            let _ = fs::remove_file(&session.temporary);
            error.to_string()
        })?;
        if let Err(error) = fs::rename(&session.temporary, &session.destination) {
            // Откат: возвращаем сохранённый файл на место. Если и это не
            // удалось, файл оператора остался в резервной копии со случайным
            // именем — об этом обязательно надо сказать, иначе он его не найдёт.
            if fs::rename(&backup, &session.destination).is_err() {
                let _ = fs::remove_file(&session.temporary);
                return Err(format!(
                    "{error}. Исходный файл не удалось вернуть на место; он сохранён как {}",
                    backup.display()
                ));
            }
            let _ = fs::remove_file(&session.temporary);
            return Err(error.to_string());
        }
        let _ = fs::remove_file(backup);
    } else if let Err(error) = fs::rename(&session.temporary, &session.destination) {
        let _ = fs::remove_file(&session.temporary);
        return Err(error.to_string());
    }
    set_private_file_permissions(&session.destination)?;
    Ok(LocalLibraryImportResult {
        path: session.relative,
        size: session.expected_size,
        status: if existed {
            "stored".into()
        } else {
            "created".into()
        },
    })
}

#[tauri::command]
pub(crate) async fn local_library_import_begin(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
    file_size: u64,
    overwrite: bool,
) -> Result<LocalImportBeginResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    if file_size == 0 || file_size > MAX_UPLOAD as u64 {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let root = local_library_printer_root(&app, &printer_id)?;
    let imports = Arc::clone(&transfers.imports);
    let import_id = hex::encode(random_bytes::<16>()?);
    let owner_id = user.id;
    bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalImportBeginResult, String> {
            let (relative, destination) = local_library_file_path(&root, &relative_path)?;
            let parent = destination
                .parent()
                .ok_or("Не удалось определить папку локальной библиотеки")?;
            create_local_library_parent(&root, parent)?;
            if let Ok(metadata) = fs::symlink_metadata(&destination) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Путь локальной библиотеки занят небезопасным объектом".into());
                }
                if !overwrite {
                    return Ok(LocalImportBeginResult {
                        import_id: None,
                        chunk_size: MAX_UPLOAD_CHUNK,
                        result: Some(LocalLibraryImportResult {
                            path: relative,
                            size: metadata.len(),
                            status: "skipped".into(),
                        }),
                    });
                }
            }
            let temporary = parent.join(format!(
                ".klipper-farm-import-{}.tmp",
                hex::encode(random_bytes::<12>()?)
            ));
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            if let Err(error) = set_private_file_permissions(&temporary) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            let session = LocalImportSession {
                file,
                temporary: temporary.clone(),
                destination,
                root,
                relative,
                expected_size: file_size,
                received_size: 0,
                overwrite,
                printer_id,
                owner_id,
                started: Instant::now(),
            };
            let mut items = imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?;
            prune_expired_local_imports(&mut items);
            if items.len() >= MAX_TRANSFER_SESSIONS {
                drop(session);
                let _ = fs::remove_file(temporary);
                return Err("Слишком много одновременных импортов G-code".into());
            }
            if items.contains_key(&import_id) {
                drop(session);
                let _ = fs::remove_file(temporary);
                return Err("Конфликт ID локального импорта — повторите операцию".into());
            }
            items.insert(import_id.clone(), session);
            Ok(LocalImportBeginResult {
                import_id: Some(import_id),
                chunk_size: MAX_UPLOAD_CHUNK,
                result: None,
            })
        },
    )
    .await
    .map_err(|error| format!("Local library import begin worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn local_library_import_chunk(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    import_id: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<u64, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_upload_id(&import_id)?;
    if data.is_empty() || data.len() > MAX_UPLOAD_CHUNK {
        return Err("Некорректный блок локального G-code".into());
    }
    let imports = Arc::clone(&transfers.imports);
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let mut session = {
            let mut items = imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?;
            items
                .remove(&import_id)
                .ok_or("Сессия локального импорта не найдена")?
        };
        if session.owner_id != user.id {
            imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?
                .insert(import_id, session);
            return Err("FORBIDDEN: импорт принадлежит другому пользователю".to_string());
        }
        if session.started.elapsed() >= UPLOAD_SESSION_TTL {
            let temporary = session.temporary.clone();
            drop(session);
            let _ = fs::remove_file(temporary);
            return Err("Сессия локального импорта истекла".into());
        }
        if offset != session.received_size
            || session.received_size.saturating_add(data.len() as u64) > session.expected_size
        {
            imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?
                .insert(import_id, session);
            return Err("Нарушен порядок блоков локального G-code".into());
        }
        if let Err(error) = session.file.write_all(&data) {
            let temporary = session.temporary.clone();
            drop(session);
            let _ = fs::remove_file(temporary);
            return Err(error.to_string());
        }
        session.received_size += data.len() as u64;
        let received = session.received_size;
        imports
            .lock()
            .map_err(|_| "Состояние локальных импортов недоступно")?
            .insert(import_id, session);
        Ok(received)
    })
    .await
    .map_err(|error| format!("Local library import chunk worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn local_library_import_finish(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    import_id: String,
) -> Result<LocalLibraryImportResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_upload_id(&import_id)?;
    let imports = Arc::clone(&transfers.imports);
    let owner_id = user.id.clone();
    let (result, printer_id) = bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let session = {
            let mut items = imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?;
            items
                .remove(&import_id)
                .ok_or("Сессия локального импорта не найдена")?
        };
        if session.owner_id != owner_id {
            imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?
                .insert(import_id, session);
            return Err("FORBIDDEN: импорт принадлежит другому пользователю".into());
        }
        if session.received_size != session.expected_size {
            imports
                .lock()
                .map_err(|_| "Состояние локальных импортов недоступно")?
                .insert(import_id, session);
            return Err("Локальный G-code передан не полностью".to_string());
        }
        let printer_id = session.printer_id.clone();
        Ok((finish_local_import(session)?, printer_id))
    })
    .await
    .map_err(|error| format!("Local library import finish worker failed: {error}"))??;
    insert_audit(
        &app,
        &user.id,
        "local_library.import_stream",
        &format!(
            "{} · {} · {} bytes · {}",
            printer_id, result.path, result.size, result.status
        ),
    )?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn local_library_import_abort(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    import_id: String,
) -> Result<bool, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    validate_upload_id(&import_id)?;
    let mut items = transfers
        .imports
        .lock()
        .map_err(|_| "Состояние локальных импортов недоступно")?;
    let Some(session) = items.remove(&import_id) else {
        return Ok(false);
    };
    if session.owner_id != user.id {
        items.insert(import_id, session);
        return Err("FORBIDDEN: импорт принадлежит другому пользователю".into());
    }
    let temporary = session.temporary.clone();
    drop(session);
    let _ = fs::remove_file(temporary);
    Ok(true)
}

#[tauri::command]
pub(crate) async fn local_library_read_begin(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
) -> Result<LocalReadBeginResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    let reads = Arc::clone(&transfers.reads);
    let read_id = hex::encode(random_bytes::<16>()?);
    let owner_id = user.id;
    bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalReadBeginResult, String> {
            let (_, path) = local_library_file_path(&root, &relative_path)?;
            validate_local_library_parent(
                &root,
                path.parent().ok_or("Не удалось определить папку G-code")?,
            )?;
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "Файл не найден в локальной библиотеке")?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Читать можно только обычный G-code файл".into());
            }
            if metadata.len() == 0 || metadata.len() > MAX_UPLOAD as u64 {
                return Err("G-code пуст или превышает лимит 100 MiB".into());
            }
            let file = fs::OpenOptions::new()
                .read(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            let size = metadata.len();
            let session = LocalReadSession {
                file,
                expected_size: size,
                received_size: 0,
                owner_id,
                started: Instant::now(),
                hasher: Sha256::new(),
            };
            let mut items = reads
                .lock()
                .map_err(|_| "Состояние чтения локальной библиотеки недоступно")?;
            items.retain(|_, session| session.started.elapsed() < UPLOAD_SESSION_TTL);
            if items.len() >= MAX_TRANSFER_SESSIONS {
                return Err("Слишком много одновременных проверок G-code".into());
            }
            if items.contains_key(&read_id) {
                return Err("Конфликт ID проверки G-code — повторите операцию".into());
            }
            items.insert(read_id.clone(), session);
            Ok(LocalReadBeginResult {
                read_id,
                size,
                chunk_size: MAX_UPLOAD_CHUNK,
            })
        },
    )
    .await
    .map_err(|error| format!("Local library read begin worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn local_library_read_chunk(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    read_id: String,
    offset: u64,
) -> Result<LocalReadChunkResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    validate_upload_id(&read_id)?;
    let reads = Arc::clone(&transfers.reads);
    bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let mut session = {
            let mut items = reads
                .lock()
                .map_err(|_| "Состояние чтения локальной библиотеки недоступно")?;
            items
                .remove(&read_id)
                .ok_or("Сессия чтения G-code не найдена")?
        };
        if session.owner_id != user.id {
            reads
                .lock()
                .map_err(|_| "Состояние чтения локальной библиотеки недоступно")?
                .insert(read_id, session);
            return Err("FORBIDDEN: проверка принадлежит другому пользователю".into());
        }
        if session.started.elapsed() >= UPLOAD_SESSION_TTL {
            return Err("Сессия проверки G-code истекла".into());
        }
        if offset != session.received_size {
            reads
                .lock()
                .map_err(|_| "Состояние чтения локальной библиотеки недоступно")?
                .insert(read_id, session);
            return Err("Нарушен порядок чтения локального G-code".into());
        }
        let remaining = session.expected_size.saturating_sub(session.received_size);
        let mut data = vec![0_u8; remaining.min(MAX_UPLOAD_CHUNK as u64) as usize];
        let read = session
            .file
            .read(&mut data)
            .map_err(|error| error.to_string())?;
        data.truncate(read);
        if data.is_empty() && remaining > 0 {
            return Err("Локальный G-code изменился или был обрезан во время проверки".into());
        }
        session.hasher.update(&data);
        session.received_size += data.len() as u64;
        let done = session.received_size == session.expected_size;
        let next_offset = session.received_size;
        let sha256 = if done {
            Some(hex::encode(session.hasher.finalize()))
        } else {
            reads
                .lock()
                .map_err(|_| "Состояние чтения локальной библиотеки недоступно")?
                .insert(read_id, session);
            None
        };
        Ok(LocalReadChunkResult {
            data,
            next_offset,
            done,
            sha256,
        })
    })
    .await
    .map_err(|error| format!("Local library read chunk worker failed: {error}"))?
}

#[tauri::command]
pub(crate) fn local_library_read_abort(
    app: AppHandle,
    auth: State<'_, AuthState>,
    transfers: State<'_, LocalTransferState>,
    session_token: String,
    read_id: String,
) -> Result<bool, String> {
    let user = require_role(&app, &auth, &session_token, Role::Viewer)?;
    validate_upload_id(&read_id)?;
    let mut items = transfers
        .reads
        .lock()
        .map_err(|_| "Состояние чтения локальной библиотеки недоступно")?;
    let Some(session) = items.remove(&read_id) else {
        return Ok(false);
    };
    if session.owner_id != user.id {
        items.insert(read_id, session);
        return Err("FORBIDDEN: проверка принадлежит другому пользователю".into());
    }
    Ok(true)
}

#[tauri::command]
pub(crate) async fn local_library_import(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
    data: Vec<u8>,
    overwrite: bool,
) -> Result<LocalLibraryImportResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    if data.is_empty() || data.len() > MAX_UPLOAD {
        return Err("G-code пуст или превышает лимит 100 MiB".into());
    }
    let root = local_library_printer_root(&app, &printer_id)?;
    let result = bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalLibraryImportResult, String> {
            let (relative, destination) = local_library_file_path(&root, &relative_path)?;
            let parent = destination
                .parent()
                .ok_or("Не удалось определить папку локальной библиотеки")?;
            create_local_library_parent(&root, parent)?;
            if let Ok(metadata) = fs::symlink_metadata(&destination) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Путь локальной библиотеки занят небезопасным объектом".into());
                }
                if !overwrite {
                    return Ok(LocalLibraryImportResult {
                        path: relative,
                        size: metadata.len(),
                        status: "skipped".into(),
                    });
                }
            }
            let temporary = parent.join(format!(
                ".klipper-farm-import-{}.tmp",
                hex::encode(random_bytes::<12>()?)
            ));
            let write_result = (|| -> Result<(), String> {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(|e| e.to_string())?;
                file.write_all(&data).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                set_private_file_permissions(&temporary)
            })();
            if let Err(error) = write_result {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            let existed = destination.exists();
            if existed && !overwrite {
                let size = fs::symlink_metadata(&destination)
                    .map_err(|e| e.to_string())?
                    .len();
                let _ = fs::remove_file(&temporary);
                return Ok(LocalLibraryImportResult {
                    path: relative,
                    size,
                    status: "skipped".into(),
                });
            }
            if existed {
                let backup = parent.join(format!(
                    ".klipper-farm-backup-{}.tmp",
                    hex::encode(random_bytes::<12>()?)
                ));
                fs::rename(&destination, &backup).map_err(|error| {
                    let _ = fs::remove_file(&temporary);
                    error.to_string()
                })?;
                if let Err(error) = fs::rename(&temporary, &destination) {
                    // То же, что и выше: если откат не удался, файл оператора
                    // лежит в резервной копии, и путь к ней надо назвать.
                    if fs::rename(&backup, &destination).is_err() {
                        let _ = fs::remove_file(&temporary);
                        return Err(format!(
                            "{error}. Исходный файл не удалось вернуть на место; он сохранён как {}",
                            backup.display()
                        ));
                    }
                    let _ = fs::remove_file(&temporary);
                    return Err(error.to_string());
                }
                let _ = fs::remove_file(backup);
            } else if let Err(error) = fs::rename(&temporary, &destination) {
                let _ = fs::remove_file(&temporary);
                return Err(error.to_string());
            }
            set_private_file_permissions(&destination)?;
            Ok(LocalLibraryImportResult {
                path: relative,
                size: data.len() as u64,
                status: if existed {
                    "stored".into()
                } else {
                    "created".into()
                },
            })
        },
    )
    .await
    .map_err(|e| format!("Local library worker failed: {e}"))??;
    insert_audit(
        &app,
        &user.id,
        "local_library.import",
        &format!(
            "{} · {} · {} bytes · {}",
            printer_id, result.path, result.size, result.status
        ),
    )?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn local_library_read_text(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
) -> Result<LocalLibraryText, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalLibraryText, String> {
            let (_, data) = read_local_library_file(&root, &relative_path, MAX_UPLOAD)?;
            Ok(LocalLibraryText {
                sha256: hex::encode(Sha256::digest(&data)),
                text: String::from_utf8_lossy(&data).into_owned(),
            })
        },
    )
    .await
    .map_err(|e| format!("Local library worker failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn local_library_read_preview_text(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
) -> Result<String, String> {
    require_role(&app, &auth, &session_token, Role::Viewer)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    bounded_spawn_blocking(ExecutionClass::FileIo, move || -> Result<String, String> {
        let data = read_local_library_prefix(&root, &relative_path, MAX_LOCAL_PREVIEW)?;
        Ok(String::from_utf8_lossy(&data).into_owned())
    })
    .await
    .map_err(|e| format!("Local library preview worker failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn local_library_delete(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
) -> Result<(), String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    let relative =
        bounded_spawn_blocking(ExecutionClass::FileIo, move || -> Result<String, String> {
            let (relative, path) = local_library_file_path(&root, &relative_path)?;
            validate_local_library_parent(
                &root,
                path.parent().ok_or("Не удалось определить папку G-code")?,
            )?;
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "Файл не найден в локальной библиотеке")?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Удалять можно только обычный G-code файл".into());
            }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            let mut parent = path.parent();
            while let Some(directory) = parent {
                if directory == root.as_path() {
                    break;
                }
                if fs::read_dir(directory)
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_some()
                {
                    break;
                }
                fs::remove_dir(directory).map_err(|e| e.to_string())?;
                parent = directory.parent();
            }
            Ok(relative)
        })
        .await
        .map_err(|e| format!("Local library worker failed: {e}"))??;
    insert_audit(
        &app,
        &user.id,
        "local_library.delete",
        &format!("{} · {}", printer_id, relative),
    )
}

#[tauri::command]
pub(crate) async fn local_library_delete_directory(
    app: AppHandle,
    auth: State<'_, AuthState>,
    session_token: String,
    printer_id: String,
    relative_path: String,
) -> Result<LocalLibraryDirectoryDeleteResult, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    let root = local_library_printer_root(&app, &printer_id)?;
    let result = bounded_spawn_blocking(
        ExecutionClass::FileIo,
        move || -> Result<LocalLibraryDirectoryDeleteResult, String> {
            let (relative, directory) = local_library_directory_path(&root, &relative_path)?;
            let parent = directory
                .parent()
                .ok_or("Не удалось определить родительскую папку")?;
            validate_local_library_parent(&root, parent)?;
            let metadata = fs::symlink_metadata(&directory)
                .map_err(|_| "Папка не найдена в локальной библиотеке")?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Удалять можно только обычную папку локальной библиотеки".into());
            }

            // Сначала полностью проверяем дерево и ничего не удаляем. Это не даёт
            // каталогу с symlink или неожиданным объектом превратиться в
            // рекурсивное удаление произвольного пути.
            let mut pending = vec![directory.clone()];
            let mut directories = vec![directory.clone()];
            let mut files = Vec::new();
            let mut total_size = 0_u64;
            let mut scanned = 0_usize;
            while let Some(current) = pending.pop() {
                validate_local_library_parent(&root, &current)?;
                for entry in fs::read_dir(&current).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                    scanned = scanned
                        .checked_add(1)
                        .ok_or("Слишком много элементов в папке")?;
                    if scanned > MAX_LOCAL_LIBRARY_FILES {
                        return Err(
                            "В папке более 5000 элементов — безопасное удаление остановлено".into(),
                        );
                    }
                    if metadata.file_type().is_symlink() {
                        return Err(
                            "В папке обнаружена символическая ссылка — удаление остановлено".into(),
                        );
                    }
                    let item_relative = path
                        .strip_prefix(&root)
                        .map_err(|_| "Повреждён путь локальной библиотеки")?
                        .to_str()
                        .ok_or("Путь локальной библиотеки должен быть в UTF-8")?
                        .replace('\\', "/");
                    if metadata.is_dir() {
                        normalize_local_library_directory(&item_relative)?;
                        pending.push(path.clone());
                        directories.push(path);
                    } else if metadata.is_file() {
                        normalize_local_library_path(&item_relative)?;
                        total_size = total_size
                            .checked_add(metadata.len())
                            .ok_or("Суммарный размер папки слишком велик")?;
                        files.push(path);
                    } else {
                        return Err(
                            "В папке обнаружен небезопасный объект — удаление остановлено".into(),
                        );
                    }
                }
            }

            // Удаляем только уже проверенные обычные G-code файлы, затем пустые
            // каталоги снизу вверх. remove_dir намеренно не рекурсивен: если
            // дерево изменилось между проверкой и удалением, операция остановится.
            for path in &files {
                let parent = path.parent().ok_or("Не удалось определить папку G-code")?;
                validate_local_library_parent(&root, parent)?;
                let metadata = fs::symlink_metadata(path)
                    .map_err(|_| "G-code изменился во время удаления папки")?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("G-code изменился во время удаления папки".into());
                }
                let item_relative = path
                    .strip_prefix(&root)
                    .map_err(|_| "Повреждён путь локальной библиотеки")?
                    .to_str()
                    .ok_or("Путь локальной библиотеки должен быть в UTF-8")?
                    .replace('\\', "/");
                normalize_local_library_path(&item_relative)?;
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
            for path in directories {
                let parent = path
                    .parent()
                    .ok_or("Не удалось определить родительскую папку")?;
                validate_local_library_parent(&root, parent)?;
                let metadata = fs::symlink_metadata(&path)
                    .map_err(|_| "Папка изменилась во время удаления")?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Папка изменилась во время удаления".into());
                }
                fs::remove_dir(&path).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::DirectoryNotEmpty {
                        "Папка изменилась во время удаления — повторите операцию".to_string()
                    } else {
                        error.to_string()
                    }
                })?;
            }

            Ok(LocalLibraryDirectoryDeleteResult {
                path: relative,
                files: files.len(),
                size: total_size,
            })
        },
    )
    .await
    .map_err(|e| format!("Local library folder worker failed: {e}"))??;
    insert_audit(
        &app,
        &user.id,
        "local_library.delete_directory",
        &format!(
            "{} · {} · {} files · {} bytes",
            printer_id, result.path, result.files, result.size
        ),
    )?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn local_library_upload_to_printer(
    app: AppHandle,
    auth: State<'_, AuthState>,
    core: State<'_, TransactionalCore>,
    session_token: String,
    relative_path: String,
    expected_sha256: String,
    library_id: String,
    printer_id: String,
    host: String,
    default_port: Option<u16>,
) -> Result<String, String> {
    let user = require_role(&app, &auth, &session_token, Role::Operator)?;
    authorize_printer_target(&app, &user, &printer_id, &host)?;
    let root = local_library_printer_root(&app, &library_id)?;
    let (_, local_path) = local_library_file_path(&root, &relative_path)?;
    let filename = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Недопустимое имя G-code")?
        .to_string();
    let target = parse_target(&host, moonraker_default_port(default_port)?)?;
    let key = stored_api_key(Some(&printer_id))?;
    let scheduler = core.scheduler();
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("Недопустимый отпечаток проверенного G-code".into());
    }
    let audit_relative_path = relative_path.clone();
    let scheduler_printer_id = printer_id.clone();
    let uploaded = bounded_spawn_blocking(ExecutionClass::FileIo, move || {
        let (_, verified_path) = local_library_file_path(&root, &relative_path)?;
        upload_verified_file_to_moonraker_blocking(
            &scheduler_printer_id,
            target,
            key,
            filename,
            verified_path,
            expected_sha256,
            &scheduler,
        )
    })
    .await
    .map_err(|e| format!("Local library upload worker failed: {e}"))??;
    insert_audit(
        &app,
        &user.id,
        "local_library.upload_to_printer",
        &format!(
            "{} · {} → {} · {}",
            library_id, audit_relative_path, printer_id, uploaded
        ),
    )?;
    Ok(uploaded)
}

