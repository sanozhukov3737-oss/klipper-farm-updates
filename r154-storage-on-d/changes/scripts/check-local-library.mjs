import fs from 'node:fs';

const read=path=>fs.readFileSync(path,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const rust=read('src-tauri/src/lib.rs')+'\n'+read('src-tauri/src/local_library_commands.rs');
const native=read('src/lib/native.ts');
const panel=read('src/components/LocalLibraryPanel.tsx');
const localAnalysis=read('src/lib/localGCodeAnalysis.ts');
const moonraker=read('src/lib/moonraker.ts');
const files=read('src/components/PrinterFilesPanel.tsx');
const app=read('src/App.tsx');
const scope=read('src/lib/localLibraryScope.ts');
const thumbnail=read('src/components/LocalGCodeThumbnail.tsx');
const styles=read('src/styles.css');
const folderDeleteStart=rust.indexOf('async fn local_library_delete_directory');
const folderDeleteEnd=rust.indexOf('#[tauri::command]',folderDeleteStart+1);
const folderDeleteRust=rust.slice(folderDeleteStart,folderDeleteEnd);

for(const command of ['local_library_list','local_library_adopt_legacy','local_library_merge_scopes','local_library_import','local_library_import_begin','local_library_import_chunk','local_library_import_finish','local_library_read_text','local_library_read_begin','local_library_read_chunk','local_library_read_preview_text','local_library_delete','local_library_delete_directory','local_library_upload_to_printer']){
  assert(rust.includes(`async fn ${command}`),`${command} native command is missing`);
  assert(rust.includes(`${command},`),`${command} is not registered in the Tauri handler`);
}
for(const command of ['local_library_import_abort','local_library_read_abort']){
  assert(rust.includes(`fn ${command}`),`${command} native command is missing`);
  assert(rust.includes(`${command},`),`${command} is not registered in the Tauri handler`);
}
assert(rust.includes('.join("local-gcode-library")')&&rust.includes('storage_paths::root(app)'),'local library must live in the private application data directory');
assert(rust.includes('.join("by-printer")')&&rust.includes('local_library_printer_scope')&&rust.includes('Sha256::digest(printer_id.as_bytes())'),'each printer must have a hashed private library namespace');
assert(rust.includes('LocalLibraryListResult')&&rust.includes('legacy_files')&&rust.includes('list_legacy_local_library_files'),'legacy shared files must be reported separately instead of leaking into printer scopes');
assert(rust.includes('normalize_local_library_path')&&rust.includes('Component::Normal')&&rust.includes('Переходы между каталогами запрещены'),'relative path traversal protection is missing');
assert(rust.includes('normalize_local_library_directory')&&rust.includes('local_library_directory_path'),'folder paths need a dedicated non-root normalizer');
assert(rust.includes('file_type().is_symlink()')&&rust.includes('validate_local_library_parent'),'local library must reject symlink escapes');
assert(rust.includes('MAX_LOCAL_LIBRARY_FILES')&&rust.includes('MAX_LOCAL_LIBRARY_PATH')&&rust.includes('MAX_UPLOAD'),'local library bounds are missing');
assert(rust.includes('MAX_LOCAL_PREVIEW: usize = 8 * 1024 * 1024')&&rust.includes('read_local_library_prefix'),'thumbnail reads must be prefix-bounded in Rust');
assert(rust.includes('.create_new(true)')&&rust.includes('fs::rename(&temporary, &destination)'),'local imports must use a private temporary file and final rename');
assert(/local_library_merge_scopes[\s\S]*?Role::Operator/.test(rust)&&/local_library_import[\s\S]*?Role::Operator/.test(rust)&&/local_library_delete[\s\S]*?Role::Operator/.test(rust)&&/local_library_delete_directory[\s\S]*?Role::Operator/.test(rust)&&/local_library_upload_to_printer[\s\S]*?Role::Operator/.test(rust),'mutating local library commands require the operator role');
assert(/local_library_(?:list|import|read_text|delete)[\s\S]*?printer_id: String/.test(rust),'local library commands must receive a printer id');
assert(rust.includes('Старые общие файлы/')&&rust.includes('local_library.adopt_legacy'),'legacy migration must require an explicit per-printer adoption action');
assert(/local_library_delete[\s\S]*?bounded_spawn_blocking\(ExecutionClass::FileIo,\s*move \|\| -> Result<String, String>/.test(rust),'local library delete worker must keep a bounded explicit Rust error type');
assert(folderDeleteStart>0&&folderDeleteRust.includes('Result<LocalLibraryDirectoryDeleteResult, String>'),'folder delete worker must keep an explicit Rust result type');
assert(folderDeleteRust.includes('fs::remove_dir(&path)')&&!folderDeleteRust.includes('remove_dir_all'),'folder deletion must remove validated files and empty directories without recursive remove_dir_all');
assert(folderDeleteRust.includes('В папке обнаружена символическая ссылка')&&folderDeleteRust.includes('normalize_local_library_path(&item_relative)'),'folder deletion must reject symlinks and non-G-code descendants before removal');
assert(/local_library_upload_to_printer[\s\S]*?authorize_printer_target/.test(rust),'local files may only be uploaded to an authorized saved printer');
assert(/local_library_upload_to_printer[\s\S]*?library_id: String[\s\S]*?printer_id: String/.test(rust),'shared library ownership must stay separate from the authorized target printer');
assert(rust.includes('expected_sha256')&&rust.includes('G-code изменился после проверки')&&rust.includes('ct_eq(expected_sha256.to_ascii_lowercase().as_bytes())'),'the exact bytes approved by preflight must be bound to the upload');
assert(rust.includes('upload_verified_file_to_moonraker_blocking')&&rust.includes('.klipper-farm-verified-upload-')&&rust.includes('.seek(SeekFrom::Start(0))'),'local printer upload is not streamed from the exact verified snapshot');
assert(rust.includes('LocalTransferState')&&rust.includes('MAX_TRANSFER_SESSIONS')&&rust.includes('MAX_UPLOAD_CHUNK'),'bounded local import/read sessions are missing');
assert(rust.includes('local_library_files_equal')&&rust.includes('Объединено из другого принтера')&&rust.includes('fs::rename(&source, &destination)'),'per-printer libraries are not merged safely into a model library');

assert(native.includes("secureInvoke<LocalLibraryListResult>('local_library_list',{printerId})")&&native.includes("secureInvoke<LocalLibraryMergeResult>('local_library_merge_scopes',{sourceIds,destinationId})")&&native.includes("secureInvoke<LocalLibraryDirectoryDeleteResult>('local_library_delete_directory',{printerId,relativePath})")&&native.includes("secureInvoke<string>('local_library_upload_to_printer'"),'frontend local library API must stay behind authenticated Tauri commands');
assert(scope.includes("preset==='custom'?printer.id:`model:${preset}`")&&scope.includes("'ender3-v3-ke':'Ender-3 V3 KE'"),'known printers must share a stable model scope while custom printers remain isolated');
assert(app.includes('<PrinterFilesPanel printer={filesPrinter} printers={printers}')&&files.includes('libraryPeerIds')&&files.includes('localLibraryScopeId(item)===libraryId'),'the file panel does not receive all same-model printers');
assert(panel.includes('const scopeId=libraryScopeId')&&panel.includes('localLibraryMergeScopes(sourceIds,scopeId)')&&panel.includes('localLibraryList(scopeId)')&&panel.includes('importLocalFile(scopeId,relativePath,file,overwrite,controller.signal)')&&panel.includes('analyzeLocalFile(scopeId,entry.path,controller.signal)')&&panel.includes('localLibraryDelete(scopeId,current.entry.path)'),'every local file operation must stay in the selected model scope');
assert(panel.includes('localLibraryDeleteDirectory(scopeId,current.path)')&&panel.includes('setFolderDelete(item)'),'folder delete must remain scoped to the selected printer and require explicit selection');
assert(panel.includes('scopeId!==scopeIdRef.current'),'late work from one printer must not populate another printer view');
assert(panel.includes('Закрепить за этой моделью')&&panel.includes('Одинаковые принтеры')&&panel.includes('Другие модели сюда не попадают'),'model ownership and explicit legacy migration are not visible in the UI');
assert(panel.includes("webkitdirectory:''")&&panel.includes('file.webkitRelativePath||file.name'),'folder import must preserve the browser-provided USB directory tree');
assert(panel.includes('const chooseFile=')&&panel.includes("void importSelection(selected,'file')")&&panel.includes('Добавить файл<input hidden'),'single-file import control is missing');
assert(panel.includes("mode==='file'")&&panel.includes('`${folder}/${file.name}`')&&panel.includes("'local_library.file_import'"),'a single file must be stored in the currently open model folder');
assert(panel.includes("/\\.(?:gcode|gco)$/i")&&panel.includes('MAX_IMPORT_FILES')&&panel.includes('MAX_FILE_SIZE'),'folder import filters and bounds are missing');
assert(panel.indexOf('validateGCodeAnalysis(printer,entry.path,analysis)')<panel.indexOf('client.uploadLocalLibrary(current.entry.path,current.sha256'),'local G-code must be fully checked before it is sent to a printer');
assert(panel.includes('file.slice(offset,end).arrayBuffer()')&&!panel.includes('await file.arrayBuffer()'),'large local imports must use bounded file slices instead of a whole-file array');
assert(panel.includes("import { analyzeLocalFile } from '../lib/localGCodeAnalysis'")&&localAnalysis.includes('analyzeGCodeByteChunks(chunks(),signal)')&&localAnalysis.includes('localLibraryReadChunk(started.readId,offset)'),'large local preflight must stream cancellable chunks instead of constructing a full UTF-16 string');
assert(panel.includes("operationAbort.current?.abort")&&panel.includes("operation==='analysis'")&&panel.includes("operation==='upload'"),'local import, analysis and transfer must expose cancellation');
assert(panel.includes("kind:'start'|'queue'|'blocked'|'delete'")&&panel.includes('printerFileDialogBackdrop'),'print, queue, block and delete actions require in-app dialogs');
assert(panel.includes('localFolderOpen')&&panel.includes('localFolderDelete')&&panel.includes('Удалить папку и файлы'),'folder rows need separate open/delete controls and an in-app confirmation');
assert(!/<button[^>]*className="localFolderCard"/.test(panel),'folder cards must not use nested buttons');
assert(!/\b(?:alert|confirm)\s*\(/.test(panel),'local library must not use browser alert/confirm dialogs');
assert(files.includes("source==='local'?<LocalLibraryPanel")&&files.includes('Моя флешка')&&files.includes('На принтере'),'printer storage and persistent local library tabs are not wired together');
assert(thumbnail.includes('IntersectionObserver')&&thumbnail.includes('embeddedGCodeThumbnailDataUrl')&&thumbnail.includes('MAX_CACHED_PREVIEWS')&&thumbnail.includes('MAX_PREVIEW_WORKERS=2'),'local embedded thumbnails must be lazy and worker-bounded');
assert(thumbnail.includes('`${printerId}:${entry.path}')||thumbnail.includes('`${printerId}:${entry.path}:${entry.size}'),'local preview cache must be isolated per printer');
assert(thumbnail.includes('localLibraryReadPreviewText(printerId,entry.path)')&&!thumbnail.includes('localLibraryReadText(printerId,entry.path)'),'thumbnail workers must not read an entire large G-code');
assert(styles.includes('.localLibraryBrowser')&&styles.includes('.localFolderCard')&&styles.includes('.localFileCard')&&styles.includes('.localLibraryLegacy'),'local folder browser styles are missing');
assert(styles.includes('.localFolderDelete')&&styles.includes('.localFolderOpen b{')&&styles.includes('font-size:13px'),'folder delete and readable folder titles are not styled');
assert(styles.includes('.localLibraryHero b,.localLibraryImport b')&&styles.includes('font-size:15px')&&styles.includes('.localLibraryToolbar input')&&styles.includes('font-size:11px'),'local library typography must stay readable');
assert(styles.includes('WebView2 stability')&&styles.includes('content-visibility:visible!important')&&styles.includes('backdrop-filter:none!important'),'WebView2 green-tile mitigation is missing from the file window');

const localUpload=moonraker.slice(moonraker.indexOf('  async uploadLocalLibrary('),moonraker.indexOf('  async temperatureStore('));
assert(localUpload.includes('localLibraryUploadToPrinter(relativePath,expectedSha256,libraryId,printerId,host,defaultPort)')&&!localUpload.includes('transferLocalLibrary(')&&!localUpload.includes('transactional_upload_'),'local library must use the archived authenticated native source-snapshot upload route');
assert(localUpload.includes('this.config.id')&&localUpload.includes('this.moonrakerEndpoint()')&&localUpload.includes('this.moonrakerDefaultPort()'),'library scope and authorized target printer/endpoint must stay separate');
assert(localUpload.includes('if(active.aborted)throw new RequestCancelledError()')&&panel.includes('Передачу файла нельзя прервать')&&panel.includes('Действие отменено. Ожидаем завершения передачи'),'native upload cancellation must prevent follow-up actions without claiming the in-flight upload stops');
console.log('local library OK: model-shared storage, lossless legacy merge, safe folder deletion, stable WebView2 paint and checked print/queue flow');
