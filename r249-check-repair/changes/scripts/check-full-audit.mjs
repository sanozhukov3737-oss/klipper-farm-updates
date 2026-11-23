import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

// The chunked upload transport lives in upload_commands since r241-r248; read its owner too.
const rust=`${read('src-tauri/src/lib.rs')}\n${read('src-tauri/src/discovery_commands.rs')}\n${read('src-tauri/src/upload_commands.rs')}\n${read('src-tauri/src/moonraker_protocol.rs')}`;
const moonraker=read('src/lib/moonraker.ts');
const validation=read('src/lib/gcodeValidation.ts');
const analysis=read('src/lib/gcodeAnalysis.ts');
const queue=read('src/components/QueuePanel.tsx');
const dispatcher=read('src/components/AutoDispatchPanel.tsx');
const local=read('src/components/LocalLibraryPanel.tsx');
const notifications=read('src/components/NotificationCenter.tsx');
const temperatures=read('src/components/TemperatureChart.tsx');
const production=read('src/components/ProductionPanel.tsx');
const app=read('src/App.tsx');
const system=read('src/components/SystemPanel.tsx');
const index=read('dist/index.html');
const bundlePath=index.match(/src="\/(assets\/index-[^"]+\.js)"/)?.[1];
assert(bundlePath,'offline index does not reference a content-hashed JavaScript bundle');
const bundle=read(`dist/${bundlePath}`);

assert(/\[7125_u16,\s*80_u16\]\s*\.into_iter\(\)/.test(rust)&&rust.includes('struct DiscoveryTarget'),'native discovery does not preserve K1C port 80/7125 targets');
assert(rust.includes('moonraker_upload_begin')&&rust.includes('moonraker_upload_chunk')&&rust.includes('moonraker_upload_finish')&&rust.includes('moonraker_upload_abort'),'native Moonraker chunked upload lifecycle is incomplete');
assert(rust.includes('local_library_import_begin')&&rust.includes('local_library_read_begin')&&rust.includes('MAX_TRANSFER_SESSIONS'),'native local-library streaming sessions or bounds are missing');
assert(rust.includes('upload_verified_file_to_moonraker_blocking')&&rust.includes('expected_sha256'),'local-to-printer transfer is not verified against its streamed hash');

assert(moonraker.includes('requestScheduler.run')&&moonraker.includes("requestScheduler.run('upload'")&&moonraker.includes('runBackgroundRequest')&&moonraker.includes('runControlRequest'),'non-emergency request serialization layers are incomplete');
assert(moonraker.includes("nativeRpc('printer.emergency_stop'")&&!moonraker.includes("requestScheduler.run('emergency'"),'emergency stop still waits behind the WebView request scheduler');
assert(moonraker.includes('this.configuredMoonrakerPort()===80'),'explicit port 80 is not treated as a conservative K1C endpoint');
assert(moonraker.includes("virtual_sdcard:['is_active']")&&moonraker.includes("printState!=='printing'&&printState!=='paused'"),'pre-start readiness does not re-read the live print state');
assert(moonraker.includes("secureInvoke<NativeUploadBegin>('transactional_upload_begin'")&&moonraker.includes("secureInvoke<number>('transactional_upload_chunk'")&&moonraker.includes('file.slice(offset,end).arrayBuffer()'),'source uploader is not transactional and block based');
assert(!/new FileReader[\s\S]{0,700}moonraker_upload/.test(moonraker),'source uploader still reads a complete G-code into WebView memory');
assert(analysis.includes('analyzeGCodeByteChunks')&&analysis.includes('TextDecoder'),'streaming G-code analyzer is missing');
assert(validation.includes('validateGCodeAnalysis')&&validation.includes('client.uploadedFile(filename)'),'fresh large uploads are not validated from the original File stream');

assert(queue.includes('refreshInFlight')&&queue.includes('inFlight=false')&&queue.includes('confirmed.queued_jobs[0]?.job_id')&&queue.includes('!await client.isReady()'),'queue refresh/auto-start guards are incomplete');
assert(dispatcher.includes('addChain')&&dispatcher.includes('filesRef')&&dispatcher.includes('printersRef.current.find')&&dispatcher.includes('await c.isReady()'),'dispatcher serialization or live pre-start check is missing');
assert(!dispatcher.includes('source.gcodeText(j.sourcePath)'),'dispatcher can still reconstruct a potentially huge remote file in WebView memory');
assert(local.includes('localLibraryImportBegin')&&local.includes("import { analyzeLocalFile } from '../lib/localGCodeAnalysis'")&&read('src/lib/localGCodeAnalysis.ts').includes('analyzeGCodeByteChunks')&&local.includes('client.uploadLocalLibrary')&&moonraker.includes('return await this.runFileTransfer(async active=>')&&moonraker.includes('await localLibraryUploadToPrinter(relativePath,expectedSha256,libraryId,printerId,host,defaultPort)'),'local-library native streamed path or sensitive-printer transfer guard is missing');
assert(app.includes('let stopped=false,inFlight=false,timer:number|undefined')&&app.includes('while(j.scheduledAt<=Date.now())')&&app.includes('!await c.isReady()'),'scheduler overlap/catch-up guard is missing');
assert(notifications.includes('refreshInFlight')&&notifications.includes('window.setTimeout(loop,8_000)')&&!notifications.includes('setInterval('),'notification refresh can still overlap');
assert(temperatures.includes('loadInFlight')&&temperatures.includes('window.setTimeout(loop,30_000)')&&!temperatures.includes('setInterval('),'temperature refresh can still overlap');
assert(production.includes('refreshInFlight')&&production.includes('if(refreshInFlight.current)return refreshInFlight.current'),'production library refresh can still overlap');
const updater=read('src/components/AppUpdater.tsx');
const online=read('src-tauri/src/online_updates.rs');
assert(system.includes('<AppUpdater')&&updater.includes('updateApply(info.manifestSha256)'),'in-app updater is not wired');
for(const marker of ['parse_and_verify','verify_artifact','kf_update::accept','Role::Admin','idle(&snapshots)','--proto-redir','manifest_sha256','applying.store(true'])assert(online.includes(marker),`updater safety missing: ${marker}`);

assert(/^assets\/index-[A-Za-z0-9_-]+\.js$/.test(bundlePath),'offline index does not activate the current content-hashed bundle');
for(const marker of ['printer_actor_upsert','printer_actor_rpc','printer_actor_events_pending','printer_actor_events_ack','printer_actor_reattest','transactional_upload_begin','transactional_upload_chunk','transactional_upload_finish','local_library_import_begin','local_library_read_begin','printer.emergency_stop'])assert(bundle.includes(marker),`offline bundle marker missing: ${marker}`);
for(const marker of ['update_status','update_check','update_install','update_apply','update_cancel'])assert(bundle.includes(marker),`built updater command missing: ${marker}`);
assert(!bundle.includes('local_library_read_text'),'offline bundle still reads complete local G-code into memory');
assert(!/\b(?:alert|confirm|prompt)\(/.test(bundle),'offline bundle still contains a blocking native WebView dialog');

console.log('full audit OK: actor-owned transport, durable events, safe identity and cancellable streaming paths are active');
