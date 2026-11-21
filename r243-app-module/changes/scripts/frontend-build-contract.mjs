import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const sorted=values=>[...new Set(values)].sort();
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const walk=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const absolute=path.join(directory,entry.name);
  assert.ok(!entry.isSymbolicLink(),`Unexpected frontend symlink: ${absolute}`);
  return entry.isDirectory()?walk(absolute):entry.isFile()?[absolute]:[];
});
const read=(root,relative)=>fs.readFileSync(path.join(root,relative),'utf8');

export function registeredNativeCommands(root){
  const source=read(root,'src-tauri/src/lib.rs');
  // Список команд вынесен в функцию invoke_handler() в lib.rs: сборка
  // приложения живёт в app.rs, а макрос __cmd__* требует область видимости корня.
  const handler=source.match(/fn invoke_handler\(\)[\s\S]*?generate_handler!\[([\s\S]*?)\]/)?.[1];
  assert.ok(handler,'Tauri invoke_handler registration is missing');
  const entries=handler.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'').split(',').map(value=>value.trim()).filter(Boolean);
  return sorted(entries.map(entry=>{
    assert.ok(/^[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*$/.test(entry),`Unsupported native command registration: ${entry}`);
    return entry.split(/\s*::\s*/).at(-1);
  }));
}

export function sourceNativeCommands(root){
  return sorted(walk(path.join(root,'src'))
    .filter(file=>/\.(ts|tsx)$/.test(file))
    .flatMap(file=>[...fs.readFileSync(file,'utf8').matchAll(/\b(?:secureInvoke|invoke)\s*(?:<[^()]*>)?\s*\(\s*['"]([a-z][a-z0-9_]+)['"]/g)].map(match=>match[1])));
}

export function validateCommandSurface(sourceCommands,nativeCommands,bundle){
  const registered=new Set(nativeCommands);
  const missing=sourceCommands.filter(command=>!registered.has(command));
  assert.deepEqual(missing,[],`Frontend calls unregistered native commands: ${missing.join(', ')}`);
  const chunks=Array.isArray(bundle)?bundle:[bundle];
  assert.ok(!/["']secret_get["']/.test(chunks.join('\n')),'Stale frontend calls removed native command secret_get');
  // Minifiers reuse names in independent chunks and lexical scopes. Identify
  // the actual binding of an invoke wrapper, not every function named "a".
  const files=new Map(chunks.map((source,index)=>[`/kf-contract/chunk-${index}.js`,source+'\nexport {};']));
  const options={allowJs:true,noResolve:true,noLib:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext};
  const host=ts.createCompilerHost(options);
  host.fileExists=file=>files.has(file);
  host.readFile=file=>files.get(file);
  host.getSourceFile=file=>files.has(file)?ts.createSourceFile(file,files.get(file),options.target,true,ts.ScriptKind.JS):undefined;
  host.writeFile=()=>{};
  const program=ts.createProgram([...files.keys()],options,host),checker=program.getTypeChecker(),calls=[];
  for(const file of program.getSourceFiles()){
    const visit=node=>{
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.arguments.length
        &&ts.isStringLiteral(node.arguments[0])&&/^[a-z][a-z0-9_]+$/.test(node.arguments[0].text)){
        calls.push({binding:checker.getSymbolAtLocation(node.expression)??`${file.fileName}:${node.expression.text}`,command:node.arguments[0].text});
      }
      ts.forEachChild(node,visit);
    };
    visit(file);
  }
  const aliases=new Set(calls.filter(call=>registered.has(call.command)).map(call=>call.binding));
  const emitted=sorted(calls.filter(call=>aliases.has(call.binding)).map(call=>call.command));
  const unknown=emitted.filter(command=>!registered.has(command));
  assert.deepEqual(unknown,[],`Built frontend calls unregistered native commands: ${unknown.join(', ')}`);
  for(const required of ['auth_status','headless_engine_status','secret_set','secret_delete','telegram_send','printer_actor_snapshots']){
    assert.ok(emitted.includes(required),`Current frontend command is missing: ${required}`);
  }
  return emitted;
}

export function frontendBuildProvenance(root){
  const inputFiles=[
    ...walk(path.join(root,'src')),
    ...['index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts','RELEASE-BUILD-ID.txt','scripts/frontend-build-contract.mjs'].map(relative=>path.join(root,relative)),
  ];
  const inputs=inputFiles.map(absolute=>({
    path:path.relative(root,absolute).split(path.sep).join('/'),
    sha256:digest(fs.readFileSync(absolute)),
  })).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  return {
    schemaVersion:1,
    buildId:read(root,'RELEASE-BUILD-ID.txt').trim(),
    sourceSha256:digest(JSON.stringify(inputs)),
    nativeCommandsSha256:digest(JSON.stringify(registeredNativeCommands(root))),
  };
}

export function validateBuildProvenance(actual,expected){
  assert.equal(actual.schemaVersion,1,'Frontend provenance schema is missing or unsupported');
  assert.equal(actual.buildId,expected.buildId,'Frontend belongs to another release build');
  assert.equal(actual.sourceSha256,expected.sourceSha256,'Frontend was not built from the packaged source');
  assert.equal(actual.nativeCommandsSha256,expected.nativeCommandsSha256,'Frontend was built for another native command registration');
}

export function verifyFrontendBuild(root){
  const chunks=walk(path.join(root,'dist')).filter(file=>file.endsWith('.js')).map(file=>fs.readFileSync(file,'utf8'));
  const bundle=chunks.join('\n');
  const emitted=validateCommandSurface(sourceNativeCommands(root),registeredNativeCommands(root),chunks);
  const provenancePath=path.join(root,'dist','BUILD-PROVENANCE.json');
  assert.ok(fs.existsSync(provenancePath),'Frontend build provenance is missing; rebuild with npm run build');
  const actual=JSON.parse(fs.readFileSync(provenancePath,'utf8'));
  validateBuildProvenance(actual,frontendBuildProvenance(root));
  assert.ok(bundle.includes(actual.buildId),'Visible frontend build identity is missing');
  return {commands:emitted.length,buildId:actual.buildId};
}

