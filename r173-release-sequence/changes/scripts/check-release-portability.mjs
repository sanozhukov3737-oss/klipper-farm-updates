#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sha256FileSync} from './large-file-hash.mjs';

const root=path.resolve(import.meta.dirname,'..');
const slash=value=>value.split(path.sep).join('/');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const digest=relative=>sha256FileSync(path.join(root,relative));
const legacyMojibake='éÇåìÄ_æìÇùÇïÇ_ÅÉÄùêÆÇÆ£.txt';
const excludedPrefixes=['.git/','node_modules/','src-tauri/target/','rv/','.klipper-build-cache/','src-tauri/binaries/','INSTALLER/'];
const excludedFiles=new Set(['tsconfig.tsbuildinfo',legacyMojibake]);
const excludedNames=new Set(['.DS_Store','Thumbs.db','desktop.ini']);
const textExtensions=new Set(['.bat','.cmd','.ps1','.sh','.mjs','.js','.json','.toml','.rs','.ts','.tsx','.css','.html','.md','.txt','.yml','.yaml','.xml','.svg']);
const decoder=new TextDecoder('utf-8',{fatal:true});
// Скрипты, которые Windows PowerShell 5.1 исполняет напрямую и которые содержат
// русский текст: без BOM он читает их как ANSI и падает на разборе.
const BOM_SCRIPTS=new Set(['scripts/install-update-components.ps1','scripts/apply-online-update.ps1']);
const files=[];

const verifyText=(relative,bytes)=>{
  const hasBom=bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]));
  // Windows PowerShell 5.1 otherwise decodes these scripts' Russian UI as the
  // system ANSI code page, which turns the text into mojibake and a parse error.
  // Only an exact listed script may carry a UTF-8 BOM; everything else must not.
  if(BOM_SCRIPTS.has(relative))assert.ok(hasBom,`Windows PowerShell script requires UTF-8 BOM: ${relative}`);
  else assert.ok(!hasBom,`UTF-8 BOM is forbidden in release text: ${relative}`);
  const content=decoder.decode(bytes);
  assert.ok(!content.includes('\u0000')&&!content.includes('\ufffd'),`invalid text content: ${relative}`);
  const lineFeeds=(content.match(/\n/g)??[]).length;
  const crlf=(content.match(/\r\n/g)??[]).length;
  assert.ok(crlf===0||crlf===lineFeeds,`mixed line endings: ${relative}`);
  assert.ok(!content.replaceAll('\r\n','').includes('\r'),`lone carriage return: ${relative}`);
  const extension=path.extname(relative).toLowerCase();
  if(extension==='.bat'||extension==='.cmd')assert.equal(crlf,lineFeeds,`Windows batch file is not CRLF: ${relative}`);
  if(extension==='.json')JSON.parse(content);
};

if(process.argv.includes('--text-encoding-self-test')){
  const bom=Buffer.from([0xef,0xbb,0xbf]);
  const utf8=Buffer.from('Проверяю компоненты.'+String.fromCharCode(10));
  // Оба скрипта исполняет Windows PowerShell 5.1: каждому нужен BOM, и ни одному
  // другому файлу он не разрешён.
  for(const helper of ['scripts/install-update-components.ps1','scripts/apply-online-update.ps1']){
    verifyText(helper,Buffer.concat([bom,utf8]));
    assert.throws(()=>verifyText(helper,utf8),/requires UTF-8 BOM/);
  }
  const helper='scripts/install-update-components.ps1';
  for(const name of ['scripts/other.ps1','scripts/INSTALL-update-components.ps1','settings.json'])assert.throws(()=>verifyText(name,Buffer.concat([bom,utf8])),/BOM is forbidden/);
  verifyText('notes.txt',utf8);
  verifyText('settings.json',Buffer.from('{"name":"Ксения"}\n'));
  assert.throws(()=>verifyText(helper,Buffer.concat([bom,Buffer.from([0xc3,0x28])])),/encoded data|UTF-8/i);
  assert.throws(()=>verifyText(helper,Buffer.concat([bom,Buffer.from('one\r\ntwo\n')])),/mixed line endings/);
  assert.throws(()=>verifyText(helper,Buffer.concat([bom,Buffer.from([0])])),/invalid text content/);
  console.log('release text encoding OK: 11 cases; only the two listed Windows PowerShell scripts require BOM');
  process.exit(0);
}

const walk=directory=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    const relative=slash(path.relative(root,absolute));
    if(excludedPrefixes.some(prefix=>relative===prefix.slice(0,-1)||relative.startsWith(prefix)))continue;
    if(excludedFiles.has(relative)||excludedNames.has(entry.name))continue;
    const stat=fs.lstatSync(absolute);
    assert.ok(!stat.isSymbolicLink(),`release contains an unexpected symlink: ${relative}`);
    if(stat.isDirectory())walk(absolute);
    else if(stat.isFile())files.push(relative);
  }
};
walk(root);
files.sort((left,right)=>left<right?-1:left>right?1:0);
assert.ok(files.length>=300,'release inventory is unexpectedly incomplete');
assert.ok(files.includes('LEGACY-INSTALL-NOTES-v1.1.1.txt'),'portable legacy install note is missing');
assert.ok(files.includes('RELEASE-BUILD-ID.txt'),'release build identity is missing');
assert.ok(files.includes('V20.6-R6-DISCOVERY-HARDENING.md'),'R6 hardening boundary is missing');
assert.ok(files.includes('V20.6-R8-TELEMETRY-MODEL-LAYOUT.md'),'R8 telemetry/model/layout boundary is missing');
assert.ok(files.includes('V20.6-R8-FIX2-ENGINE-STARTUP-RACE.md'),'R8 FIX2 engine-startup boundary is missing');
assert.ok(files.includes('V20.6-R8-FIX3-AUDIT-HARDENING.md'),'R8 FIX3 audit-hardening boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3-2026-09-12.md'),'FIX3 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.2-ENGINE-FAILOVER.md'),'R8 FIX3.2 engine-failover boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.2-2026-09-12.md'),'FIX3.2 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.3-DAEMON-BOOT-RECOVERY.md'),'R8 FIX3.3 daemon-recovery boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.3-2026-09-12.md'),'FIX3.3 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.4-WINDOWS-NATIVE-IPC-PROBE.md'),'R8 FIX3.4 native Windows IPC boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.4-2026-09-12.md'),'FIX3.4 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.5-RESTART-LIFECYCLE.md'),'R8 FIX3.5 restart-lifecycle boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.5-2026-09-12.md'),'FIX3.5 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.6-DURABLE-ACTOR-RECOVERY.md'),'R8 FIX3.6 durable-actor boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.6-2026-09-13.md'),'FIX3.6 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.7-WINDOWS-SOCKET-SHUTDOWN.md'),'R8 FIX3.7 socket-shutdown boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.7-2026-09-13.md'),'FIX3.7 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.8-GRACEFUL-WINDOWS-IPC-DRAIN.md'),'R8 FIX3.8 graceful IPC-drain boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.8-2026-09-13.md'),'FIX3.8 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.9-NONBLOCKING-ACTOR-SNAPSHOT.md'),'R8 FIX3.9 nonblocking actor-snapshot boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.9-2026-09-13.md'),'FIX3.9 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.10-ENGINE-QUARANTINE-UI-RECOVERY.md'),'R8 FIX3.10 engine/quarantine/UI recovery boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.10-2026-09-13.md'),'FIX3.10 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.11-STALE-DAEMON-TAKEOVER.md'),'R8 FIX3.11 stale-daemon takeover boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.11-2026-09-13.md'),'FIX3.11 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.12-ENGINE-OWNERSHIP-RECOVERY.md'),'R8 FIX3.12 engine-ownership recovery boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.12-2026-09-13.md'),'FIX3.12 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.13-IDENTITY-CONNECTION-RECOVERY.md'),'R8 FIX3.13 identity/connection recovery boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.13-2026-09-13.md'),'FIX3.13 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.14-VERIFIED-MUTEX-OWNER-RECOVERY.md'),'R8 FIX3.14 verified mutex-owner recovery boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.14-2026-09-13.md'),'FIX3.14 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.15-CLEAN-QUARANTINE-GATE.md'),'R8 FIX3.15 clean quarantine gate boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.15-2026-09-13.md'),'FIX3.15 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.16-FORMAT-INDEPENDENT-VERIFICATION.md'),'R8 FIX3.16 format-independent verification boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.16-2026-09-13.md'),'FIX3.16 verification record is missing');
assert.ok(files.includes('V20.6-R8-FIX3.17-STABLE-VERIFICATION-GATES.md'),'R8 FIX3.17 stable verification boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R8-FIX3.17-2026-09-13.md'),'FIX3.17 verification record is missing');
assert.ok(files.includes('V20.6-R9-CLEAN-ONE-CLICK-INSTALLER.md'),'R9 clean installer boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R9-2026-09-13.md'),'R9 verification record is missing');
assert.ok(files.includes('V20.6-R9.1-DIRECT-NSIS-INSTALL.md'),'R9.1 direct NSIS boundary is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R9.9-2026-10-14.md'),'R9.9 browser layout verification record is missing');
assert.ok(files.includes('dist/BUILD-PROVENANCE.json'),'frontend build provenance is missing');
assert.ok(files.includes('VERIFICATION-V20.6-R6-2026-09-11.txt'),'R6 verification record is missing');
assert.ok(!files.includes(legacyMojibake),'mojibake legacy filename must never be packaged');
assert.ok(!files.includes('tsconfig.tsbuildinfo'),'TypeScript incremental cache must never be packaged');

const folded=new Map();
const reserved=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
for(const relative of files){
  assert.match(relative,/^[\x20-\x7e]+$/,`non-ASCII release path: ${relative}`);
  assert.ok(relative.length<=220,`release path exceeds 220 characters: ${relative}`);
  for(const component of relative.split('/')){
    assert.ok(component&&!/[<>:"\\|?*]/.test(component),`Windows-invalid release path: ${relative}`);
    assert.ok(!/[ .]$/.test(component),`Windows path ends in a dot or space: ${relative}`);
    assert.ok(!reserved.test(component),`Windows-reserved release path: ${relative}`);
    assert.ok(Buffer.byteLength(component)<=255,`oversized release path component: ${relative}`);
  }
  const foldedPath=relative.normalize('NFC').toLowerCase();
  assert.ok(!folded.has(foldedPath),`case-insensitive path collision: ${folded.get(foldedPath)} <> ${relative}`);
  folded.set(foldedPath,relative);

  const extension=path.extname(relative).toLowerCase();
  if(!textExtensions.has(extension))continue;
  const bytes=fs.readFileSync(path.join(root,relative));
  verifyText(relative,bytes);
}

const parseManifest=relative=>{
  const entries=new Map();
  let lineNumber=0;
  for(const raw of read(relative).split(/\r?\n/)){
    lineNumber+=1;
    if(!raw.trim()||raw.trimStart().startsWith('#'))continue;
    const match=raw.match(/^([0-9a-f]{64}) \*([\x20-\x7e]+)$/);
    assert.ok(match,`${relative}:${lineNumber}: malformed manifest line`);
    const [,hash,file]=match;
    assert.ok(!entries.has(file),`${relative}:${lineNumber}: duplicate path ${file}`);
    assert.ok(files.includes(file),`${relative}:${lineNumber}: path is not packaged: ${file}`);
    assert.equal(digest(file),hash,`${relative}:${lineNumber}: checksum mismatch: ${file}`);
    entries.set(file,hash);
  }
  assert.ok(entries.size>0,`${relative}: no file entries`);
  return entries;
};
const releaseManifest=parseManifest('MANIFEST-SHA256.txt');
const expectedManifestFiles=files.filter(relative=>relative!=='MANIFEST-SHA256.txt');
assert.deepEqual([...releaseManifest.keys()].sort(),expectedManifestFiles,'release manifest does not cover the exact packaged inventory');
const offlineManifest=parseManifest('OFFLINE-PAYLOAD-SHA256.txt');
assert.ok(offlineManifest.size>=29,'offline payload manifest is unexpectedly incomplete');

// R114 ships its camera model and WASM runtime inside the offline frontend.
// Source metadata alone cannot prove that Vite copied the binary payload.
const cameraModel=JSON.parse(read('public/camera-detector/MODEL.json'));
assert.equal(cameraModel.id,'obico-failure-5a6b1be1fa','unexpected camera model identity');
assert.equal(cameraModel.sha256,'0a6ebd8e30dbf6a450c50f9c0a5406f04ba7eb1c99fd5996e888c78bb383b9aa','camera model is not the reviewed weights');
assert.equal(cameraModel.size,202223918,'camera model size contract changed');
assert.equal(cameraModel.runtime,'onnxruntime-web@1.23.2','camera runtime is not the locked version');
assert.deepEqual(JSON.parse(read('dist/camera-detector/MODEL.json')),cameraModel,'prebuilt detector metadata differs from source');
for(const prefix of ['public','dist']){
  const modelFile=`${prefix}/camera-detector/${cameraModel.file}`;
  assert.ok(files.includes(modelFile),`packaged camera model is missing: ${modelFile}`);
  assert.equal(fs.statSync(path.join(root,modelFile)).size,cameraModel.size,`packaged camera model size mismatch: ${modelFile}`);
  assert.equal(digest(modelFile),cameraModel.sha256,`packaged camera model hash mismatch: ${modelFile}`);
  for(const asset of cameraModel.assets){
    const runtimeFile=`${prefix}/camera-detector/${asset.filename}`;
    assert.ok(files.includes(runtimeFile),`packaged camera runtime is missing: ${runtimeFile}`);
    assert.equal(digest(runtimeFile),asset.sha256,`packaged camera runtime hash mismatch: ${runtimeFile}`);
  }
  for(const license of cameraModel.licenses)assert.ok(files.includes(`${prefix}/camera-detector/${license}`),`camera license is missing: ${prefix}/${license}`);
}
for(const file of [cameraModel.file,'MODEL.json',...cameraModel.assets.map(asset=>asset.filename),...cameraModel.licenses]){
  assert.ok(offlineManifest.has(`dist/camera-detector/${file}`),`offline frontend manifest omits camera payload: ${file}`);
}

const packageJson=JSON.parse(read('package.json'));
const packageLock=JSON.parse(read('package-lock.json'));
const attributes=read('.gitattributes');
assert.equal(read('RELEASE-BUILD-ID.txt').trim(),'V20.6-R15.7-UPDATE-DELIVERY-PRODUCTION-CANDIDATE-2026-11-11','release build identity is not the update delivery frontend/native contract');
const updateChannel=JSON.parse(read('UPDATE-CHANNEL.json'));
assert.equal(updateChannel.installedSequence,157,'packaged production updater sequence must match R157');
assert.equal(updateChannel.channel,'stable');
assert.equal(updateChannel.publicKeyHex,'28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb');
assert.equal(updateChannel.endpoint,'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json');
assert.ok(attributes.includes('*.bat text eol=crlf')&&attributes.includes('*.node binary')&&attributes.includes('*.gz binary'),'Git checkout can corrupt Windows line endings or packaged binaries');
assert.equal(packageJson.engines?.node,'>=20.11','Node minimum must cover import.meta.dirname');
assert.equal(packageLock.packages?.['']?.engines?.node,packageJson.engines.node,'package-lock Node minimum is stale');
for(const name of ['verify:v14','verify:v16','verify:v17','verify:v18','verify:v19']){
  assert.ok(packageJson.scripts?.[name]?.includes('verification-lab-v20.mjs'),`${name} bypasses current V20 gates`);
}
assert.ok(packageJson.scripts?.['verify:v20']?.includes('verification-lab-r9.mjs'),'verify:v20 does not use the R9 clean verification lab');
assert.ok(packageJson.scripts?.['install:windows']?.includes('build-and-install-windows.mjs'),'package scripts bypass the clean Windows installer');

const launcher=read('FIX_AND_INSTALL.bat');
const installer=read('scripts/build-and-install-windows.mjs');
assert.ok(launcher.includes('setlocal EnableExtensions DisableDelayedExpansion'),'installer must preserve exclamation marks in paths');
assert.ok(!launcher.includes('!KF_'),'installer reintroduced delayed path expansion');
assert.ok(launcher.includes('Node.js 20.11 or newer'),'installer has no explicit Node compatibility error');
assert.ok(launcher.includes('scripts\\build-and-install-windows.mjs'),'launcher bypasses the clean installer orchestrator');
for(const marker of ["verifyManifest('release'","verifyManifest('offline'",'scripts/run-rust-tests.mjs','scripts/prepare-windows-build-cache.mjs','scripts/check-desktop-packaging.mjs','scripts/check-windows-gui-binaries.mjs']){
  assert.ok(installer.includes(marker),`clean installer is missing ${marker}`);
}
assert.ok(!installer.includes('verification-lab-v20')&&!installer.includes('check-fix3-'),'legacy verification gates returned to the install path');
assert.ok(!installer.includes('check-desktop-startup-smoke.mjs'),'uninstalled desktop smoke can still block a completed installer');
assert.ok(!installer.includes('npm.cmd')&&!installer.includes("cargo',['fmt'"),'installer downloads dependencies or rewrites packaged source');
assert.ok(!`${launcher}\n${installer}`.includes('Get-Content -LiteralPath $env:KF_'),'inline locale-dependent manifest parsing returned');

const manifestVerifier=read('scripts/verify-release-manifest.ps1');
for(const marker of ['UTF8Encoding]::new($false, $true)','IsPathRooted','ReparsePoint','StartsWith($rootPrefix','Duplicate $Kind manifest path','Get-FileHash']){
  assert.ok(manifestVerifier.includes(marker),`manifest verifier is missing ${marker}`);
}
for(const script of ['scripts/generate-updater-signing.ps1','scripts/publish-first-release.ps1']){
  const source=read(script);
  assert.ok(source.includes('UTF8Encoding]::new($false, $true)'),`${script} does not read strict UTF-8`);
  assert.ok(source.includes('UTF8Encoding]::new($false)'),`${script} does not write UTF-8 without BOM`);
  assert.ok(!source.includes('Set-Content -Encoding UTF8'),`${script} can reintroduce a PowerShell 5.1 UTF-8 BOM`);
}

assert.deepEqual(files.filter(relative=>relative==='FIX_AND_INSTALL.bat'||/^VERIFY_AND_BUILD_.*\.bat$/.test(relative)),['FIX_AND_INSTALL.bat'],'release packages multiple Windows build entry points');

const releaseConfig=JSON.parse(read('src-tauri/tauri.release.conf.json'));
const offlineConfig=JSON.parse(read('src-tauri/tauri.offline.conf.json'));
const tauriConfig=JSON.parse(read('src-tauri/tauri.conf.json'));
for(const [name,config] of [['base',tauriConfig],['release',releaseConfig],['offline',offlineConfig]])assert.equal(config.mainBinaryName,'klipper-farm-client',`${name} Tauri config does not pin the GUI binary`);
assert.deepEqual(releaseConfig.bundle.externalBin,['binaries/klipper-farmd'],'publisher release omits klipper-farmd');
assert.deepEqual(offlineConfig.bundle.externalBin,['binaries/klipper-farmd'],'offline release omits klipper-farmd');
const releaseWorkflow=read('.github/workflows/release.yml');
for(const marker of ['windows-2022','macos-15','macos-15-intel','Extract locked Rust vendor','run-rust-tests.mjs','cargo clippy','Build production daemon sidecar','npm run prepare:sidecar']){
  assert.ok(releaseWorkflow.includes(marker),`release workflow is missing ${marker}`);
}
assert.ok(!releaseWorkflow.includes('macos-13')&&!releaseWorkflow.includes('macos-14\n'),'release workflow uses a retired/deprecated macOS runner');
assert.ok(releaseWorkflow.indexOf('Extract locked Rust vendor')<releaseWorkflow.indexOf('run-rust-tests.mjs'),'release tests run before vendor extraction');
assert.ok(releaseWorkflow.indexOf('npm run prepare:sidecar')<releaseWorkflow.indexOf('tauri-apps/tauri-action'),'Tauri bundles can be created before the daemon sidecar');

const rustTestRunner=read('scripts/run-rust-tests.mjs');
const windowsLoaderGate=read('scripts/check-windows-test-loader.mjs');
for(const marker of ['--no-run','--message-format=json-diagnostic-rendered-ansi','check-windows-test-loader.mjs',"MIN_ROOT_TEST_COUNT=process.platform==='win32'?129:127",'--test-threads=1',"['clean','-p','klipper-farm-client'",'RELEASE-BUILD-ID.txt']){
  assert.ok(rustTestRunner.includes(marker),`Windows Rust test runner is missing ${marker}`);
}
const cachePreparation=read('scripts/prepare-windows-build-cache.mjs');
for(const marker of ['source-fingerprint-v1.json','manifestSha256','isWithin','--self-test'])assert.ok(cachePreparation.includes(marker),`Windows cache preparation is missing ${marker}`);
const windowsAudit=read('scripts/audit-windows-native.mjs');
for(const marker of ['whoami.exe','durable_fs::rename_atomic','MIN_ROOT_TEST_COUNT','--test-threads=1','check-desktop-packaging.mjs','check-desktop-startup-smoke.mjs','FOCUS_ACK','TEST_MUTEX_PREFIX'])assert.ok(windowsAudit.includes(marker),`Windows native audit is missing ${marker}`);
for(const marker of ['TaskDialogIndirect','MZ','CARGO_TARGET_DIR']){
  assert.ok(windowsLoaderGate.includes(marker),`Windows PE loader gate is missing ${marker}`);
}

for(const script of ['scripts/build-reproducible-zip.mjs','scripts/generate-release-manifests.mjs','scripts/generate-sbom.mjs']){
  assert.ok(!read(script).includes('localeCompare'),`${script} uses locale-dependent release ordering`);
}
const zipBuilder=read('scripts/build-reproducible-zip.mjs');
for(const marker of ['Refusing to package symlink','fs.fsyncSync','fs.renameSync(temporary,output)']){
  assert.ok(zipBuilder.includes(marker),`ZIP builder lost its fail-closed/atomic write invariant: ${marker}`);
}

console.log(`release portability OK: ${files.length} packaged files, ${releaseManifest.size} checksums, ${offlineManifest.size} offline inputs, Windows-safe names/UTF-8/CRLF/CI`);
