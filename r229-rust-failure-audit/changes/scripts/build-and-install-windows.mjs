#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const cacheRoot=path.join(root,'.klipper-build-cache');
const targetRoot=path.join(cacheRoot,'target');
// SQLite and NSIS use legacy Windows path limits. Keep temporary paths short
// and separate each checkout without inheriting its full directory depth.
const tempRoot=process.platform==='win32'
  ?path.join(os.tmpdir(),'kf-build',createHash('sha256').update(root).digest('hex').slice(0,16))
  :path.join(cacheRoot,'temp');
const logRoot=path.join(cacheRoot,'logs');
const logPath=path.join(logRoot,'BUILD-AND-INSTALL.log');
const failurePath=path.join(logRoot,'BUILD-FAILURE.txt');
const installerRoot=path.join(root,'INSTALLER');
const rustVendor=path.join(root,'rv');
const rustArchive=path.join(root,'offline-tools','rust','rust-vendor-v1144.tar.gz');
const nsisArchive=path.join(root,'offline-tools','nsis','nsis-3.11.zip');
const nsisPlugin=path.join(root,'offline-tools','nsis','nsis_tauri_utils-0.5.3.dll');
const nsisTools=path.join(targetRoot,'.tauri','NSIS');
const tauriCli=path.join(root,'offline-tools','tauri-cli','node_modules','@tauri-apps','cli','tauri.js');
const offlineConfig=path.join(root,'src-tauri','tauri.offline.conf.json');
const manifestVerifier=path.join(root,'scripts','verify-release-manifest.ps1');
const releaseManifest=path.join(root,'MANIFEST-SHA256.txt');
const offlineManifest=path.join(root,'OFFLINE-PAYLOAD-SHA256.txt');
const cargoManifest=path.join(root,'src-tauri','Cargo.toml');
const buildIdFile=path.join(root,'RELEASE-BUILD-ID.txt');

const stages=[
  'required tools','package integrity','frontend payload','build cache fingerprint',
  'offline payload extraction','build cache source refresh','Cargo metadata',
  'Rust tests','Clippy','daemon sidecar','Windows IPC probe','NSIS build',
  'desktop binary checks','installer collection',
];

if(process.argv.includes('--self-test')){
  if(stages.length!==14||new Set(stages).size!==stages.length)throw new Error('clean installer stage inventory is invalid');
  for(const required of [rustArchive,nsisArchive,nsisPlugin,tauriCli,offlineConfig,manifestVerifier,releaseManifest,offlineManifest,cargoManifest,buildIdFile]){
    if(!fs.existsSync(required))throw new Error(`missing packaged input: ${path.relative(root,required)}`);
  }
  console.log(`R9.9 direct NSIS installer self-test OK: ${stages.length} linear stages, one entry point and one full log`);
  process.exit(0);
}

fs.mkdirSync(logRoot,{recursive:true});
const log=fs.createWriteStream(logPath,{flags:'w'});
let currentStage='initialization';

const write=(stream,text)=>{
  stream.write(text);
  log.write(text);
};
const out=text=>write(process.stdout,String(text));
const err=text=>write(process.stderr,String(text));
const line=text=>out(`${text}\n`);

class StageFailure extends Error{
  constructor(stage,command,exitCode){
    super(`${stage} failed with exit code ${exitCode}`);
    this.stage=stage;
    this.command=command;
    this.exitCode=exitCode;
  }
}

const cleanDisplay=(command,args)=>[command,...args].map(value=>String(value).includes(' ')?`"${value}"`:value).join(' ');
const run=(stage,command,args=[],options={})=>new Promise((resolve,reject)=>{
  currentStage=stage;
  const display=cleanDisplay(command,args);
  line(`\n[${stage}]`);
  line(`> ${display}`);
  const child=spawn(command,args,{
    cwd:options.cwd??root,
    env:options.env??buildEnv,
    shell:false,
    windowsHide:false,
    stdio:['inherit','pipe','pipe'],
  });
  child.stdout.on('data',chunk=>write(process.stdout,chunk));
  child.stderr.on('data',chunk=>write(process.stderr,chunk));
  child.once('error',error=>reject(new StageFailure(stage,`${display}: ${error.message}`,1)));
  child.once('close',(code,signal)=>{
    if(code===0)return resolve();
    reject(new StageFailure(stage,signal?`${display} (signal ${signal})`:display,Number.isInteger(code)?code:1));
  });
});

const runNode=(stage,relative,args=[])=>run(stage,process.execPath,[path.join(root,relative),...args]);

const ensureInsideRoot=candidate=>{
  const resolved=path.resolve(candidate);
  const prefix=`${root}${path.sep}`.toLowerCase();
  if(!resolved.toLowerCase().startsWith(prefix))throw new Error(`refusing path outside project: ${resolved}`);
  return resolved;
};
const removeOwned=candidate=>{
  const resolved=ensureInsideRoot(candidate);
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
};
const requireFile=file=>{
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new StageFailure(currentStage,`missing ${path.relative(root,file)}`,1);
};
const findFiles=(directory,predicate)=>{
  if(!fs.existsSync(directory))return [];
  const found=[];
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())found.push(...findFiles(absolute,predicate));
    else if(entry.isFile()&&predicate(absolute))found.push(absolute);
  }
  return found;
};

const buildEnv={
  ...process.env,
  CARGO_HOME:path.join(cacheRoot,'cargo'),
  CARGO_TARGET_DIR:targetRoot,
  TEMP:tempRoot,
  TMP:tempRoot,
  CARGO_NET_OFFLINE:'true',
  CARGO_INCREMENTAL:'0',
  CARGO_PROFILE_RELEASE_DEBUG:'0',
  CARGO_PROFILE_RELEASE_INCREMENTAL:'false',
};
// Windows PowerShell 5.1 must build its own module path when launched by pwsh.
for(const name of Object.keys(buildEnv))if(name.toLowerCase()==='psmodulepath')delete buildEnv[name];

const verifyManifest=(kind,file)=>run(`${kind} manifest`, 'powershell.exe',[
  '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-File',manifestVerifier,'-ManifestPath',file,'-RootPath',root,'-Kind',kind,
]);

const closeLog=()=>new Promise(resolve=>log.end(resolve));

try{
  line('============================================================');
  line('  Klipper Farm v1.14.5 - R145 Offline Voice Preview');
  line('============================================================');
  line(`Project: ${root}`);
  line(`Full log: ${logPath}`);
  const buildId=fs.readFileSync(buildIdFile,'utf8').trim();
  if(!/^[A-Z0-9][A-Z0-9._-]{7,95}$/.test(buildId))throw new StageFailure('package integrity','RELEASE-BUILD-ID.txt is missing or malformed',1);
  line(`Release build ID: ${buildId}`);

  if(process.platform!=='win32'||process.arch!=='x64')throw new StageFailure('required tools',`requires win32-x64, found ${process.platform}-${process.arch}`,1);
  const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
  if(nodeMajor<20||(nodeMajor===20&&nodeMinor<11))throw new StageFailure('required tools',`Node ${process.versions.node}; required 20.11+`,1);

  fs.mkdirSync(cacheRoot,{recursive:true});
  fs.mkdirSync(buildEnv.CARGO_HOME,{recursive:true});
  fs.mkdirSync(targetRoot,{recursive:true});
  fs.mkdirSync(tempRoot,{recursive:true});
  removeOwned(installerRoot);

  await run('required tools',process.execPath,['--version']);
  await run('required tools','cargo',['--version']);
  await run('required tools','rustc',['--version']);
  await run('required tools','cargo',['clippy','--version']);
  await run('required tools','tar',['--version']);
  await run('required tools','powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()']);

  const disk=fs.statfsSync(root);
  const freeBytes=Number(disk.bavail)*Number(disk.bsize);
  line(`Free space: ${Math.floor(freeBytes/1024/1024/1024)} GB`);
  if(freeBytes<12*1024**3)throw new StageFailure('required tools','at least 12 GB free space is required',2);

  currentStage='package integrity';
  for(const file of [rustArchive,nsisArchive,nsisPlugin,tauriCli,offlineConfig,manifestVerifier,releaseManifest,offlineManifest,cargoManifest,buildIdFile])requireFile(file);
  await verifyManifest('release',releaseManifest);
  await verifyManifest('offline',offlineManifest);
  await runNode('frontend payload','scripts/check-production-bundle.mjs');
  await runNode('build cache fingerprint','scripts/prepare-windows-build-cache.mjs');

  currentStage='offline payload extraction';
  const vendorMarker=path.join(rustVendor,'.kf-v1144-complete');
  if(!fs.existsSync(vendorMarker)){
    removeOwned(rustVendor);
    await run('offline payload extraction','tar',['-xzf',rustArchive,'-C',root]);
    requireFile(path.join(rustVendor,'serde-1.0.229','Cargo.toml'));
    fs.writeFileSync(vendorMarker,'verified\n');
  }
  const nsisExecutable=path.join(nsisTools,'makensis.exe');
  const nsisPluginTarget=path.join(nsisTools,'Plugins','x86-unicode','additional','nsis_tauri_utils.dll');
  if(!fs.existsSync(nsisExecutable)||!fs.existsSync(nsisPluginTarget)){
    removeOwned(nsisTools);
    removeOwned(path.join(targetRoot,'.tauri','nsis-3.11'));
    fs.mkdirSync(path.join(targetRoot,'.tauri'),{recursive:true});
    await run('offline payload extraction','powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',
      '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:KF_NSIS_ARCHIVE -DestinationPath (Join-Path $env:CARGO_TARGET_DIR ".tauri") -Force'],{
      env:{...buildEnv,KF_NSIS_ARCHIVE:nsisArchive},
    });
    fs.renameSync(path.join(targetRoot,'.tauri','nsis-3.11'),nsisTools);
    fs.mkdirSync(path.dirname(nsisPluginTarget),{recursive:true});
    fs.copyFileSync(nsisPlugin,nsisPluginTarget);
  }
  requireFile(nsisExecutable);
  requireFile(nsisPluginTarget);

  await runNode('build cache source refresh','scripts/prepare-windows-build-cache.mjs',['--clean-workspace']);
  await run('Cargo metadata','cargo',['metadata','--offline','--locked','--manifest-path',cargoManifest,'--format-version','1','--no-deps']);
  await run('update cache cleanup','powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'scripts','check-update-cache.ps1')]);
  await runNode('update gate','scripts/check-update-gate.mjs');
  await runNode('HTTP keep-alive regression','scripts/check-http-keepalive.mjs');
  await runNode('native upload regression','scripts/check-native-upload-runtime.mjs');
  await runNode('native local-library upload regression','scripts/check-legacy-library-upload-runtime.mjs');
  await runNode('native REST RPC regression','scripts/check-native-rest-rpc-runtime.mjs');
  await runNode('Rust tests','scripts/run-rust-tests.mjs');
  // let_underscore_must_use: у `let _ = что-то()`, где результат помечен
  // must_use, теряется ровно то, что автор языка просил проверить. В проекте
  // таких мест 244, большинство — уборка временных файлов, где молчание
  // уместно. Поэтому линт в режиме предупреждения: он не ломает сборку, но
  // новый молчаливый отказ видно сразу. Разбор по классам — в R229.
  await run('Clippy','cargo',['clippy','--offline','--locked','--workspace','--all-targets','--features','fault-injection','--manifest-path',cargoManifest,'--','-W','clippy::let_underscore_must_use']);

  await runNode('daemon sidecar','scripts/prepare-sidecar.mjs');
  await run('Windows IPC probe','cargo',['build','--offline','--locked','--release','--manifest-path',cargoManifest,'--bin','klipper-farm-ipc-probe']);

  await run('NSIS build',process.execPath,[tauriCli,'build','--bundles','nsis','--config',offlineConfig,'--ci']);
  const desktopExe=path.join(targetRoot,'release','klipper-farm-client.exe');
  const daemonExe=path.join(targetRoot,'release','klipper-farmd.exe');
  const probeExe=path.join(targetRoot,'release','klipper-farm-ipc-probe.exe');
  for(const file of [desktopExe,daemonExe,probeExe])requireFile(file);
  await runNode('desktop binary checks','scripts/check-windows-gui-binaries.mjs',[desktopExe,daemonExe]);
  await runNode('desktop binary checks','scripts/check-desktop-packaging.mjs',['--generated-root',path.join(targetRoot,'release','nsis')]);

  currentStage='installer collection';
  fs.mkdirSync(installerRoot,{recursive:true});
  const installers=findFiles(path.join(targetRoot,'release','bundle','nsis'),file=>file.toLowerCase().endsWith('.exe')).sort();
  if(!installers.length)throw new StageFailure(currentStage,'NSIS setup.exe was not found',1);
  for(const source of installers)fs.copyFileSync(source,path.join(installerRoot,path.basename(source)));
  const installer=path.join(installerRoot,path.basename(installers.at(-1)));

  line('\n============================================================');
  line('  BUILD SUCCESSFUL');
  line('============================================================');
  line(`Installer: ${installer}`);
  line(`Full log: ${logPath}`);
  await closeLog();
  if(!process.argv.includes('--build-only'))spawn(installer,[],{detached:true,stdio:'ignore',cwd:installerRoot}).unref();
  process.exitCode=0;
}catch(error){
  const failure=error instanceof StageFailure
    ? error
    : new StageFailure(currentStage,error instanceof Error?error.stack??error.message:String(error),1);
  const summary=[
    'BUILD AND INSTALL FAILED',
    `Stage: ${failure.stage}`,
    `Exit code: ${failure.exitCode}`,
    `Command/detail: ${failure.command}`,
    `Full log: ${logPath}`,
    '',
  ].join('\r\n');
  err(`\n============================================================\n  BUILD AND INSTALL FAILED\n============================================================\n`);
  err(`Stage: ${failure.stage}\nExit code: ${failure.exitCode}\nCommand/detail: ${failure.command}\n`);
  err(`Full log: ${logPath}\n`);
  fs.writeFileSync(failurePath,summary);
  await closeLog();
  process.exitCode=failure.exitCode||1;
}
