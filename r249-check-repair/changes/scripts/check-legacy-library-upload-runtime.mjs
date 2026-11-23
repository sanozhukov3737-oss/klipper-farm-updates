import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const section=(text,start,end)=>{
  const begin=text.indexOf(start),finish=text.indexOf(end,begin+start.length);
  assert.ok(begin>=0&&finish>begin,`native extraction markers missing: ${start}`);
  // The end marker can be preceded by the next item's `pub(crate)`; leaving it behind would
  // splice a visibility keyword in front of an unrelated item in the harness.
  return text.slice(begin,finish).replace(/pub\(crate\)\s*$/,'');
};
const main=read('src-tauri/src/lib.rs');
// The upload transport moved out of lib.rs into its own module; extract from the owner.
const upload=read('src-tauri/src/upload_commands.rs');
const actual=section(upload,'fn upload_verified_file_to_moonraker_blocking(','#[tauri::command]');
const responsePath=section(upload,'fn legacy_upload_response_path(','fn validate_upload_id(');
const uploads=read('src-tauri/src/transactional_core/upload.rs');
const uploadError=section(uploads,'pub(crate) fn upload_http_error(','#[allow(clippy::too_many_arguments)]\nfn scheduled_upload_final_file(');
assert.ok(actual.includes('Copy the validated bytes into a private immutable snapshot')&&actual.includes('open_chunked_upload(')&&!actual.includes('tcp_stream_round_trip'));
const safeName=section(upload,'fn safe_upload_name(','fn upload_to_moonraker_blocking(');
const random=section(main,'fn random_bytes<','fn validate_pin(');
const session=section(main,'struct UploadSession {','#[derive(Clone, Default)]\nstruct LocalTransferState');
const protocol=read('src-tauri/src/moonraker_protocol.rs');
const parser=section(protocol,'pub(crate) fn decode_chunked_bytes(','pub(crate) fn http_request(');
const schedulerSource=read('src-tauri/src/transactional_core/scheduler.rs');
const scheduler=schedulerSource.slice(0,schedulerSource.indexOf('#[cfg(test)]'));
const types=read('src-tauri/src/transactional_core/types.rs');
const priority=section(types,'#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = "snake_case")]\npub enum OperationPriority','#[derive(Debug, Clone, Serialize, Deserialize, Default)]');
const snapshot=section(types,'#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(rename_all = "camelCase")]\npub struct SchedulerSnapshot','pub fn classify_method(');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'kf-legacy-library-upload-'));
const size=25_568_163;
const repeated=Buffer.from('; legacy native library upload regression, no machine commands\r\n'.repeat(Math.ceil(size/63)+1));
const ending=Buffer.from('; no final newline');
const data=Buffer.concat([repeated.subarray(0,size-ending.length),ending]);
assert.equal(data.length,size);
const source=path.join(temporary,'original-source.gcode');fs.writeFileSync(source,data);
const digest=crypto.createHash('sha256').update(data).digest('hex');
const originalFilename='Корпус К1С 🧵 — PLA_é (legacy)-25MB.gcode';
fs.mkdirSync(path.join(temporary,'src'));
fs.writeFileSync(path.join(temporary,'Cargo.toml'),`[package]\nname="kf-legacy-library-upload-runtime"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nkf-moonraker={path=${JSON.stringify(path.join(root,'src-tauri/crates/kf-moonraker').replaceAll('\\','/'))}}\nserde={version="1",features=["derive"]}\nserde_json="1"\nsha2="0.10"\nsubtle="2"\ngetrandom="0.2"\nhex="0.4"\n`);
const harness=String.raw`
#![allow(dead_code)]
use std::{collections::HashMap,fs,io::{Read,Write,Seek,SeekFrom},net::{SocketAddr,TcpStream},path::{Path,PathBuf},time::{Duration,Instant}};
use getrandom::getrandom;
use sha2::{Digest,Sha256};
use subtle::ConstantTimeEq;
const MAX_UPLOAD:usize=100*1024*1024;
const MAX_UPLOAD_CHUNK:usize=512*1024;
const MAX_JSON_RESPONSE:usize=2*1024*1024;
struct HttpTarget{socket:SocketAddr,authority:String}
struct HttpResponse{status:u16,content_type:Option<String>,body:Vec<u8>}
fn header_boundary(raw:&[u8])->Option<usize>{raw.windows(4).position(|part|part==b"\r\n\r\n")}
fn validate_header_value(value:&str,_max:usize)->Result<(),String>{if value.contains(['\r','\n']){Err("header injection".into())}else{Ok(())}}
// ACL commands are outside this transport harness; Unix file permissions stay
// private, while Windows ACL behavior is covered by native application tests.
fn set_private_file_permissions(path:&Path)->Result<(),String>{
 #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;fs::set_permissions(path,fs::Permissions::from_mode(0o600)).map_err(|error|error.to_string())?;}
 #[cfg(not(unix))]let _=path;
 Ok(())
}
SAFE_NAME
RANDOM
SESSION
PARSER
RESPONSE_PATH
mod transactional_core{
 pub mod diagnostics{pub fn redact_text(value:&str)->String{value.into()}}
 pub mod upload{UPLOAD_ERROR}
 pub mod types{use serde::{Serialize,Deserialize};
 PRIORITY
 SNAPSHOT
 }
 pub mod scheduler{
 SCHEDULER
 }
}
ACTUAL
#[cfg(test)]mod regression{
 use super::*;
 fn clean_snapshots(directory:&Path){
  let leftovers=fs::read_dir(directory).unwrap().map(|entry|entry.unwrap().file_name().to_string_lossy().into_owned()).filter(|name|name.starts_with(".klipper-farm-verified-upload-")).collect::<Vec<_>>();
  assert!(leftovers.is_empty(),"immutable snapshots must be removed after success/error: {leftovers:?}");
 }
 #[test]fn exact_legacy_upload_snapshot_keepalive_and_one_attempt_errors(){
  let original=fs::read(SOURCE).unwrap();
  assert_eq!(original.len(),25_568_163);
  assert_eq!(hex::encode(Sha256::digest(&original)),DIGEST);
  for mode in ["snapshot-keepalive","http-500"]{
   let case=Path::new(SOURCE).parent().unwrap().join(mode);fs::create_dir(&case).unwrap();
   let source=case.join(UPLOAD_NAME);fs::write(&source,&original).unwrap();
   let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
   let expected=original.clone();let source_on_server=source.clone();let case_on_server=case.clone();
   let(returned_sender,returned_receiver)=std::sync::mpsc::channel();
   let server=std::thread::spawn(move||{
    let(mut stream,_)=listener.accept().unwrap();stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(25))).unwrap();
    let mut raw=Vec::new();let mut block=[0_u8;16*1024];
    let(end,length,boundary)=loop{
     let count=stream.read(&mut block).unwrap();assert!(count>0);raw.extend_from_slice(&block[..count]);
     if let Some(end)=header_boundary(&raw){
      let headers=String::from_utf8_lossy(&raw[..end]);
      assert_eq!(headers.lines().next().unwrap(),"POST /server/files/upload HTTP/1.1","uploader must never send a print/start command");
      assert!(headers.lines().any(|line|line=="X-Api-Key: regression-key"));
      assert!(!headers.to_ascii_lowercase().contains("transfer-encoding:"));
      let length=headers.lines().find_map(|line|line.strip_prefix("Content-Length: ")).unwrap().trim().parse::<usize>().unwrap();
      let boundary=headers.lines().find_map(|line|line.strip_prefix("Content-Type: multipart/form-data; boundary=")).unwrap().to_string();
      assert!(boundary.starts_with("KlipperFarm"));assert_eq!(boundary.len(),"KlipperFarm".len()+32);
      assert!(boundary["KlipperFarm".len()..].bytes().all(|byte|byte.is_ascii_hexdigit()));
      break(end+4,length,boundary)
     }
    };
    if mode=="snapshot-keepalive"{
     // Replacing the original after the TCP connection cannot alter the private
     // snapshot already hashed by the real native uploader.
     fs::write(&source_on_server,b"; original changed after immutable snapshot\r\n").unwrap();
     let snapshots=fs::read_dir(&case_on_server).unwrap().filter_map(Result::ok).filter(|entry|entry.file_name().to_string_lossy().starts_with(".klipper-farm-verified-upload-")).map(|entry|entry.path()).collect::<Vec<_>>();
     assert_eq!(snapshots.len(),1,"one immutable snapshot must exist during upload");
     assert_eq!(hex::encode(Sha256::digest(fs::read(&snapshots[0]).unwrap())),DIGEST);
    }
    while raw.len()<end+length{let count=stream.read(&mut block).unwrap();assert!(count>0);raw.extend_from_slice(&block[..count]);}
    assert_eq!(raw.len(),end+length);
    let body=&raw[end..];
    let prefix=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n",UPLOAD_NAME);
    let suffix=format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n--{boundary}--\r\n");
    assert_eq!(&body[..prefix.len()],prefix.as_bytes());
    let file=&body[prefix.len()..prefix.len()+expected.len()];
    assert_eq!(file,expected.as_slice());assert_eq!(hex::encode(Sha256::digest(file)),DIGEST);
    assert_eq!(&body[prefix.len()+expected.len()..],suffix.as_bytes(),"legacy multipart has only file and root, without checksum/print fields");
    let(status,response)=if mode=="http-500"{("500 Internal Server Error",serde_json::json!({"error":{"code":500,"message":"upload file fail"}}))}else{("201 Created",serde_json::json!({"result":{"item":{"path":UPLOAD_NAME}}}))};
    let response=response.to_string();
    write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{response}",response.len()).unwrap();
    // Hold the socket open until the uploader returns. This catches waiting for
    // TCP close rather than honoring the complete HTTP Content-Length frame.
    let framed=returned_receiver.recv_timeout(Duration::from_secs(3)).is_ok();
    listener.set_nonblocking(true).unwrap();
    assert!(listener.accept().is_err(),"unexpected retry or print/start connection");
    assert!(framed,"native uploader waited for TCP close instead of complete HTTP response");
   });
   let scheduler=transactional_core::scheduler::FarmScheduler::default();
   let started=Instant::now();
   let result=upload_verified_file_to_moonraker_blocking("legacy-test",HttpTarget{socket:address,authority:address.to_string()},Some("regression-key".into()),UPLOAD_NAME.into(),source.clone(),DIGEST.into(),&scheduler);
   returned_sender.send(()).ok();server.join().unwrap();
   if mode=="http-500"{let error=result.unwrap_err();assert!(error.contains("Upload HTTP 500:")&&error.contains("upload file fail"));}else{
    assert_eq!(result.unwrap(),UPLOAD_NAME);
    assert_ne!(hex::encode(Sha256::digest(fs::read(&source).unwrap())),DIGEST,"source mutation must actually occur during the test");
   }
   assert!(started.elapsed()>=Duration::from_secs(4),"real bandwidth scheduler must pace the 25MB transfer");
   clean_snapshots(&case);
  }
 }
 #[test]fn changed_source_is_refused_before_any_network_connection(){
  let case=Path::new(SOURCE).parent().unwrap().join("changed-before-upload");fs::create_dir(&case).unwrap();let source=case.join("original.gcode");
  fs::write(&source,b"; source replaced after prior validation\r\n").unwrap();
  let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();listener.set_nonblocking(true).unwrap();
  let result=upload_verified_file_to_moonraker_blocking("legacy-test",HttpTarget{socket:address,authority:address.to_string()},None,UPLOAD_NAME.into(),source,DIGEST.into(),&transactional_core::scheduler::FarmScheduler::default());
  assert!(result.unwrap_err().contains("G-code изменился после проверки"));
  assert!(listener.accept().is_err(),"changed source must fail before any upload connection");clean_snapshots(&case);
 }
 #[test]fn invalid_multipart_names_are_refused_before_any_network_connection(){
  let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();listener.set_nonblocking(true).unwrap();
  for name in ["bad\"name.gcode","bad\r\nX-Injected: yes.gcode","bad\0name.gcode"]{
   let result=upload_verified_file_to_moonraker_blocking("legacy-test",HttpTarget{socket:address,authority:address.to_string()},None,name.into(),PathBuf::from(SOURCE),DIGEST.into(),&transactional_core::scheduler::FarmScheduler::default());
   assert!(result.unwrap_err().contains("Недопустимое имя файла"));assert!(listener.accept().is_err(),"unsafe multipart filename reached the printer");
  }
 }
 #[test]fn upload_acknowledgement_must_confirm_the_requested_file(){
  let response=|status,body:&str|HttpResponse{status,content_type:None,body:body.as_bytes().to_vec()};
  for body in [r#"{"result":{"item":{"path":"source.gcode","size":42}}}"#,r#"{"item":{"path":"gcodes/source.gcode","size":42}}"#]{
   assert_eq!(legacy_upload_response_path(&response(201,body),"source.gcode",42).unwrap(),"source.gcode");
  }
  for (body,message) in [
   (r#"{"error":{"message":"printer refused this file"}}"#,"printer refused this file"),
   (r#"{"result":{"item":{"size":42}}}"#,"не подтвердил путь"),
   (r#"{"result":{"item":{"path":"other.gcode"}}}"#,"неожиданному пути"),
   (r#"{"result":{"item":{"path":"source.gcode","size":43}}}"#,"неверный размер"),
   (r#"{"result":{"item":{"path":"source.gcode","size":"42"}}}"#,"неверный размер"),
   ("not JSON","invalid JSON"),
  ]{
   let error=legacy_upload_response_path(&response(200,body),"source.gcode",42).unwrap_err();assert!(error.contains(message),"{error}");
  }
  let error=legacy_upload_response_path(&response(500,&"x".repeat(10000)),"source.gcode",42).unwrap_err();
  assert!(error.starts_with("Upload HTTP 500:")&&error.len()<1600);
 }
}
`;
const replacements={SAFE_NAME:safeName,RANDOM:random,SESSION:session,PARSER:parser,RESPONSE_PATH:responsePath,UPLOAD_ERROR:uploadError,PRIORITY:priority,SNAPSHOT:snapshot,SCHEDULER:scheduler,ACTUAL:actual,SOURCE:JSON.stringify(source.replaceAll('\\','/')),DIGEST:JSON.stringify(digest),UPLOAD_NAME:JSON.stringify(originalFilename)};
let compiled=harness;
for(const[key,value]of Object.entries(replacements))compiled=compiled.replaceAll(key,value);
fs.writeFileSync(path.join(temporary,'src/lib.rs'),compiled);
const result=spawnSync('cargo',['test','--offline','--manifest-path',path.join(temporary,'Cargo.toml'),'--','--nocapture'],{cwd:root,encoding:'utf8',timeout:120_000,env:{...process.env,CARGO_TARGET_DIR:process.env.CARGO_TARGET_DIR??path.join(root,'src-tauri/target')}});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,`actual legacy local-library native regression failed: ${result.error??''}`);
console.log(`PASS actual preserved local-library uploader: ${data.length} exact bytes and SHA, exact Cyrillic/emoji/mixed filename, original multipart file+root, real scheduler, immutable snapshot despite source replacement, keep-alive response framing, HTTP500 one attempt/no print command, changed source and unsafe multipart names rejected before network; platform ACL command shim only`);
fs.rmSync(temporary,{recursive:true,force:true});
