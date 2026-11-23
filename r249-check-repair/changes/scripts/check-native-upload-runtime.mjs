import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
// A silent empty slice turned a missing marker into an unexplained "unclosed delimiter" compile error.
const section=(text,start,end)=>{
  const begin=text.indexOf(start),finish=text.indexOf(end,begin+start.length);
  assert.ok(begin>=0&&finish>begin,`native extraction markers missing: ${start} ... ${end}`);
  return text.slice(begin,finish);
};
const upload=read('src-tauri/src/transactional_core/upload.rs');
const actual=section(upload,'fn upload_final_file(','#[allow(clippy::too_many_arguments)]\nfn scheduled_upload_final_file(');
assert.ok(actual.includes('tcp_stream_round_trip')&&actual.includes('upload_http_error'));
const boundedLine=section(upload,'fn read_bounded_line<','#[allow(clippy::too_many_arguments)]\nfn hash_exact<');
assert.ok(boundedLine.includes('read_line(output)'));
const main=read('src-tauri/src/lib.rs');
// safe_upload_name moved out of lib.rs into the upload module; random_bytes stayed behind.
const uploadCommands=read('src-tauri/src/upload_commands.rs');
const safeName=section(uploadCommands,'fn safe_upload_name(','fn upload_to_moonraker_blocking(');
const random=section(main,'fn random_bytes<','fn validate_pin(');
const protocol=read('src-tauri/src/moonraker_protocol.rs');
const parser=section(protocol,'pub(crate) fn decode_chunked_bytes(','pub(crate) fn http_request(');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'kf-native-upload-'));
const data=Buffer.from('; neutral large upload regression, no machine commands\r\n'.repeat(446_428)+'; no final newline');
const source=path.join(temporary,'neutral.gcode');fs.writeFileSync(source,data);
const originalName='C:\\input\\Корпус К1С 🧵 — PLA_é (large)-1.gcode';
const finalName=originalName.split(/[\\/]/).at(-1);
fs.mkdirSync(path.join(temporary,'src'));
fs.writeFileSync(path.join(temporary,'Cargo.toml'),`[package]\nname="kf-upload-runtime-regression"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nkf-moonraker={path=${JSON.stringify(path.join(root,'src-tauri/crates/kf-moonraker').replaceAll('\\','/'))}}\ntokio={version="1.53.1",features=["rt-multi-thread","sync"]}\nserde_json="1"\ngetrandom="0.2"\nhex="0.4"\n`);
const harness=String.raw`
use std::{collections::HashMap,net::SocketAddr};
use getrandom::getrandom;
struct HttpTarget{socket:SocketAddr,authority:String}
struct HttpResponse{status:u16,content_type:Option<String>,body:Vec<u8>}
const MAX_JSON_RESPONSE:usize=2*1024*1024;
const MAX_UPLOAD_CHUNK:usize=512*1024;
fn header_boundary(raw:&[u8])->Option<usize>{raw.windows(4).position(|p|p==b"\r\n\r\n")}
fn validate_header_value(value:&str,_max:usize)->Result<(),String>{if value.contains(['\r','\n']){Err("header injection".into())}else{Ok(())}}
SAFE_NAME
RANDOM
PARSER
mod transactional_core {
 pub mod diagnostics {pub fn redact_text(value:&str)->String{value.into()}}
 pub mod scheduler {
  use std::{time::Duration,sync::atomic::AtomicBool};
  #[derive(Default)]pub struct FarmScheduler;
  impl FarmScheduler{pub fn acquire_bandwidth_for(&self,_:&str,_:usize,_:super::upload::OperationPriority,_:Duration,_:Option<&AtomicBool>)->Result<(),String>{Ok(())}}
 }
 pub mod engine_runtime {
  pub enum ExecutionClass{FileIo}
  pub async fn spawn_blocking<T:Send+'static>(_:ExecutionClass,f:impl FnOnce()->T+Send+'static)->Result<T,String>{tokio::task::spawn_blocking(f).await.map_err(|e|e.to_string())}
 }
 mod upload {
  use crate::*;
  use serde_json::Value;
  use std::{fs::OpenOptions,io::{BufRead,Read,Write},path::Path,sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
  #[derive(Clone,Copy)]pub enum OperationPriority{Upload}
  ACTUAL
  BOUNDED_LINE
  #[test]fn interrupted_remote_headers_fail_instead_of_spinning_on_eof(){
   let mut reader=std::io::Cursor::new(b"HTTP/1.1 200 OK\r\nContent-Length: 42\r\n");let mut line=String::new();
   read_bounded_line(&mut reader,&mut line).unwrap();read_bounded_line(&mut reader,&mut line).unwrap();
   assert!(read_bounded_line(&mut reader,&mut line).unwrap_err().contains("ended before the headers were complete"));
   let mut terminated=std::io::Cursor::new(b"\r\n");read_bounded_line(&mut terminated,&mut line).unwrap();assert_eq!(line,"\r\n");
   assert!(read_bounded_line(&mut terminated,&mut line).is_err());
  }
  #[test]fn invalid_multipart_names_fail_before_any_network_connection(){
   let fixture=std::fs::read(SOURCE).unwrap();
   let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let socket=listener.local_addr().unwrap();listener.set_nonblocking(true).unwrap();
   for name in ["bad\"name.gcode","bad\r\nX-Injected: yes.gcode","bad\0name.gcode"]{
    let result=upload_final_file("test",HttpTarget{socket,authority:socket.to_string()},None,name,Path::new(SOURCE),fixture.len() as u64,&Arc::new(super::scheduler::FarmScheduler),&Arc::new(AtomicBool::new(false)));
    assert!(result.unwrap_err().contains("Недопустимое имя файла"));assert!(listener.accept().is_err(),"unsafe multipart filename reached the printer");
   }
  }
  #[test]fn legacy_wire_format_exact_large_file_and_no_error_replay(){
   let fixture=std::fs::read(SOURCE).unwrap();
   let mut boundaries=std::collections::HashSet::new();
   for mode in ["normal","path-prefix","item-shape","generic-422","checksum-422","http-500","auth-401","auth-403","json-error","wrong-path","wrong-size","missing-path"]{
    let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let socket=listener.local_addr().unwrap();
    let expected=fixture.clone();
    let server=std::thread::spawn(move||{
     let(mut stream,_)=listener.accept().unwrap();stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
     let mut raw=Vec::new();let mut block=[0;16384];let (end,length,boundary)=loop{
      let n=stream.read(&mut block).unwrap();assert!(n>0);raw.extend_from_slice(&block[..n]);
      if let Some(end)=header_boundary(&raw){
       let head=String::from_utf8_lossy(&raw[..end]);
       assert_eq!(head.lines().next().unwrap(),"POST /server/files/upload HTTP/1.1");
       let length=head.lines().find_map(|line|line.strip_prefix("Content-Length: ")).unwrap().trim().parse::<usize>().unwrap();
       let boundary=head.lines().find_map(|line|line.strip_prefix("Content-Type: multipart/form-data; boundary=")).unwrap().to_string();
       assert!(boundary.starts_with("KlipperFarm"));
       assert_eq!(boundary.len(),"KlipperFarm".len()+32);
       assert!(boundary["KlipperFarm".len()..].bytes().all(|byte|byte.is_ascii_hexdigit()));
       assert!(head.lines().any(|line|line=="X-Api-Key: test-api-key"));
       break(end+4,length,boundary)
      }
     };
     while raw.len()<end+length{let n=stream.read(&mut block).unwrap();assert!(n>0);raw.extend_from_slice(&block[..n]);}
     assert_eq!(raw.len(),end+length);
     let body=&raw[end..];
     let prefix=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n",FINAL_NAME);
     let suffix=format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n--{boundary}--\r\n");
     assert_eq!(&body[..prefix.len()],prefix.as_bytes(),"original Unicode filename must remain byte-exact");
     assert_eq!(&body[prefix.len()..prefix.len()+expected.len()],expected.as_slice(),"large file must remain byte-exact");
     assert_eq!(&body[prefix.len()+expected.len()..],suffix.as_bytes(),"only legacy file and root fields are allowed");
     let(status,response)=match mode{
      "generic-422"=>("422 Unprocessable Entity",serde_json::json!({"error":{"message":"other validation refusal: regression server detail"}})),
      "checksum-422"=>("422 Unprocessable Entity",serde_json::json!({"error":{"code":422,"message":"File checksum mismatch: expected abc, calculated def"}})),
      "http-500"=>("500 Internal Server Error",serde_json::json!({"error":{"code":500,"message":"upload file fail"}})),
      "auth-401"=>("401 Unauthorized",serde_json::json!({"error":{"message":"API key required"}})),
      "auth-403"=>("403 Forbidden",serde_json::json!({"error":{"message":"upload forbidden"}})),
      "json-error"=>("200 OK",serde_json::json!({"error":{"message":"refused in JSON body"}})),
      "wrong-path"=>("201 Created",serde_json::json!({"result":{"item":{"path":"unrequested.gcode"}}})),
      "wrong-size"=>("201 Created",serde_json::json!({"result":{"item":{"path":FINAL_NAME,"size":expected.len()+1}}})),
      "missing-path"=>("201 Created",serde_json::json!({"result":{"item":{"size":expected.len()}}})),
      "path-prefix"=>("201 Created",serde_json::json!({"result":{"item":{"path":format!("gcodes/{}",FINAL_NAME),"size":expected.len()}}})),
      "item-shape"=>("201 Created",serde_json::json!({"item":{"path":FINAL_NAME,"size":expected.len()}})),
      _=>("201 Created",serde_json::json!({"result":{"item":{"path":FINAL_NAME,"size":expected.len()}}})),
     };
     let response=response.to_string();
     write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{response}",response.len()).unwrap();
     listener.set_nonblocking(true).unwrap();
     assert!(listener.accept().is_err(),"unexpected extra upload attempt");
     boundary
    });
    let runtime=tokio::runtime::Runtime::new().unwrap();let _enter=runtime.enter();
    let result=upload_final_file("test",HttpTarget{socket,authority:socket.to_string()},Some("test-api-key".into()),ORIGINAL_NAME,Path::new(SOURCE),fixture.len() as u64,&Arc::new(super::scheduler::FarmScheduler),&Arc::new(AtomicBool::new(false)));
    let boundary=server.join().unwrap();assert!(boundaries.insert(boundary),"upload boundary must be random");
    let expected_error=match mode{
     "normal"|"path-prefix"|"item-shape"=>{assert_eq!(result.unwrap(),FINAL_NAME);continue},
     "generic-422"=>"other validation refusal: regression server detail",
     "checksum-422"=>"File checksum mismatch:",
     "http-500"=>"Upload HTTP 500: {\"error\":{\"code\":500,\"message\":\"upload file fail\"}}",
     "auth-401"=>"Upload HTTP 401:",
     "auth-403"=>"Upload HTTP 403:",
     "json-error"=>"refused in JSON body",
     "wrong-path"=>"неожиданному пути",
     "wrong-size"=>"неверный размер",
     _=>"не подтвердил путь",
    };
    let error=result.unwrap_err();assert!(error.contains(expected_error),"{mode}: {error}");
   }
  }
 }
}
`.replace('\nSAFE_NAME\n','\n'+safeName+'\n').replace('\nRANDOM\n','\n'+random+'\n').replace('\nPARSER\n','\n'+parser+'\n').replace('  ACTUAL\n',actual+'\n').replace('  BOUNDED_LINE\n',boundedLine+'\n').replaceAll('SOURCE',JSON.stringify(source.replaceAll('\\','/'))).replaceAll('ORIGINAL_NAME',JSON.stringify(originalName)).replaceAll('FINAL_NAME',JSON.stringify(finalName));
fs.writeFileSync(path.join(temporary,'src/lib.rs'),harness);
const result=spawnSync('cargo',['test','--offline','--manifest-path',path.join(temporary,'Cargo.toml'),'--','--nocapture'],{cwd:root,encoding:'utf8',timeout:120_000,env:{...process.env,CARGO_TARGET_DIR:process.env.CARGO_TARGET_DIR??path.join(root,'src-tauri/target')}});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,`actual native upload regression failed: ${result.error??''}`);
console.log(`PASS actual legacy upload protocol: ${data.length} exact bytes with no final newline; exact Cyrillic/emoji/mixed filename; invalid multipart names blocked before network; random boundary; only file+root fields; 12 cases cover success responses, HTTP/JSON errors, wrong path/size, and no retries`);
fs.rmSync(temporary,{recursive:true,force:true});
