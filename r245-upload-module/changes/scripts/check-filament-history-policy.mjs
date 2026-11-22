import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const rust=fs.readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
// endpoint_allowed вынесен в upload_commands (R245).
const upload=fs.readFileSync(new URL('../src-tauri/src/upload_commands.rs',import.meta.url),'utf8');
const start=upload.indexOf('fn endpoint_allowed(');assert.ok(start>=0);
let end=upload.indexOf('{',start),depth=1;
while(depth&&++end<upload.length){if(upload[end]==='{')depth++;else if(upload[end]==='}')depth--;}
assert.equal(depth,0);
const names=['read_one_history_job','history_query_is_read_only','other_mutations_remain_blocked','similar_routes_remain_blocked','encoded_traversal_remains_blocked','normal_history_still_allowed','existing_file_delete_scope_is_unchanged'];
const tests=`
#[test] fn read_one_history_job(){assert!(endpoint_allowed("GET","/server/history/job?uid=000001"));}
#[test] fn history_query_is_read_only(){assert!(!endpoint_allowed("DELETE","/server/history/job?uid=000001"));}
#[test] fn other_mutations_remain_blocked(){for method in ["POST","PUT","PATCH"]{assert!(!endpoint_allowed(method,"/server/history/job?uid=000001"));}}
#[test] fn similar_routes_remain_blocked(){for route in ["/server/history/job-extra?uid=1","/server/history/job/delete?uid=1"]{assert!(!endpoint_allowed("GET",route));}}
#[test] fn encoded_traversal_remains_blocked(){for route in ["/server/history/job?uid=%2e%2e","/server/history/job?uid=%5c","/server/history/job?uid=%00"]{assert!(!endpoint_allowed("GET",route));}}
#[test] fn normal_history_still_allowed(){assert!(endpoint_allowed("GET","/server/history/list?limit=100"));}
#[test] fn existing_file_delete_scope_is_unchanged(){assert!(endpoint_allowed("DELETE","/server/files/gcodes/part.gcode"));assert!(!endpoint_allowed("DELETE","/server/history/list?all=true"));}
`;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kf-filament-policy-'));
try{
 const input=path.join(directory,'policy.rs'),binary=path.join(directory,process.platform==='win32'?'policy.exe':'policy');
 fs.writeFileSync(input,upload.slice(start,end+1)+'\n'+tests);
 execFileSync(process.env.KF_RUSTC??'rustc',['--edition=2021','--test',input,'-o',binary],{encoding:'utf8',timeout:30000});
 const output=execFileSync(binary,[],{encoding:'utf8',timeout:10000});assert.match(output,/7 passed; 0 failed/);
 const result={passed:names.length,cases:names,scope:'Exact production endpoint_allowed function compiled and executed with rustc; full Tauri/Windows build not run.'};
 if(process.env.KF_NATIVE_POLICY_PROOF)fs.writeFileSync(process.env.KF_NATIVE_POLICY_PROOF,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{fs.rmSync(directory,{recursive:true,force:true})}
