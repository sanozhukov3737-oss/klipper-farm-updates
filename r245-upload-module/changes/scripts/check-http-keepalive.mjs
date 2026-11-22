#!/usr/bin/env node
// Execute the exact published/current synchronous readers in a std-only Rust
// harness. The server releases its connection only AFTER the client returns.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const baseline=process.argv.includes('--expect-baseline-timeout');
const at=process.argv.indexOf('--source');
const sourceRoot=at<0?root:path.resolve(process.argv[at+1]);
const read=relative=>fs.readFileSync(path.join(sourceRoot,relative),'utf8');
const protocol=read('src-tauri/src/moonraker_protocol.rs');
// Загрузка вынесена в upload_commands (R245): read_http_response_from_stream и
// open_chunked_upload живут там, основной файл их больше не содержит.
const main=(read('src-tauri/src/lib.rs')+String.fromCharCode(10)+read('src-tauri/src/upload_commands.rs')).replace(/pub\(crate\)\s+/g,'');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'kf-http-framing-'));
const source=path.join(temporary,'reader.rs');
const executable=path.join(temporary,process.platform==='win32'?'reader.exe':'reader');
const parser=protocol.slice(protocol.indexOf('pub(crate) fn decode_chunked_bytes('),protocol.indexOf('pub(crate) fn http_request('));
const bound=protocol.slice(protocol.indexOf('pub(crate) fn http_request_bound('),protocol.indexOf('#[allow(clippy::too_many_arguments)]',protocol.indexOf('pub(crate) fn http_request_bound(')));
const upload=main.slice(main.indexOf('fn read_http_response_from_stream('),main.indexOf('fn open_chunked_upload('));
assert.ok(bound.includes('Moonraker response timeout')&&upload.includes('Moonraker upload response timeout'));
const framing=path.join(root,'src-tauri/crates/kf-moonraker/src/http_framing.rs');
const harness=String.raw`
extern crate self as kf_moonraker;
#[path=FRAMING_PATH] pub mod http_framing;
use std::{collections::HashMap,io::{Read,Write},net::{TcpStream,TcpListener,SocketAddr,IpAddr},time::{Duration,Instant},sync::mpsc};
const MAX_UPLOAD:usize=100*1024*1024;
struct HttpTarget { socket:SocketAddr, authority:String }
#[derive(Debug)] struct HttpResponse { status:u16, content_type:Option<String>, body:Vec<u8> }
fn connect_tcp_stream(socket:SocketAddr, timeout:Duration, _bind:Option<IpAddr>)->Result<TcpStream,String>{TcpStream::connect_timeout(&socket,timeout).map_err(|e|e.to_string())}
fn validate_header_value(value:&str,_maximum:usize)->Result<(),String>{if value.contains(['\r','\n']){Err("header injection".into())}else{Ok(())}}
fn header_boundary(raw:&[u8])->Option<usize>{raw.windows(4).position(|p|p==b"\r\n\r\n")}
PARSER
BOUND
UPLOAD
#[test] fn rpc_keep_alive_content_length(){check(false,false)}
#[test] fn rpc_keep_alive_chunked(){check(false,true)}
#[test] fn upload_keep_alive_content_length(){check(true,false)}
#[test] fn upload_keep_alive_chunked(){check(true,true)}
fn check(upload:bool,chunked:bool){
 let listener=TcpListener::bind("127.0.0.1:0").unwrap();let socket=listener.local_addr().unwrap();
 let (release,wait)=mpsc::channel();
 let server=std::thread::spawn(move||{
  let(mut stream,_)=listener.accept().unwrap();let mut request=Vec::new();let mut one=[0;1];
  while !request.ends_with(b"\r\n\r\n"){stream.read_exact(&mut one).unwrap();request.push(one[0]);assert!(request.len()<4096)}
  let wire=if chunked {b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n2\r\n{}\r\n0\r\n\r\n".as_slice()}
           else{b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}".as_slice()};
  stream.write_all(wire).unwrap();let _=wait.recv_timeout(Duration::from_secs(5));
 });
 let result=if upload{
  let mut stream=TcpStream::connect(socket).unwrap();stream.write_all(b"GET /test HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
  read_http_response_from_stream(&mut stream,1024,Duration::from_millis(300))
 }else{http_request_bound(&HttpTarget{socket,authority:socket.to_string()},"GET","/test",None,None,&[],1024,Duration::from_millis(300),None)};
 let _=release.send(());server.join().unwrap();
 let response=result.expect("complete HTTP response must succeed while peer remains open");assert_eq!(response.status,200);assert_eq!(response.body,b"{}");
}
`.replace('FRAMING_PATH',JSON.stringify(framing)).replace('\nPARSER\n','\n'+parser+'\n').replace('\nBOUND\n','\n'+bound+'\n').replace('\nUPLOAD\n','\n'+upload+'\n');
fs.writeFileSync(source,harness);
const compiled=spawnSync('rustc',['--edition=2021','--test',source,'-o',executable],{encoding:'utf8',timeout:60_000});
assert.equal(compiled.status,0,`HTTP reader regression harness did not compile:\n${compiled.stderr}`);
const result=spawnSync(executable,['--nocapture'],{encoding:'utf8',timeout:20_000});
if(baseline){assert.equal(result.status,101,'published baseline unexpectedly passed: reproduction changed');assert.match(result.stdout+result.stderr,/Moonraker (?:upload )?response timeout/);console.log('BASELINE REPRODUCED: four exact R104 readers timed out after complete keep-alive replies');}
else{process.stdout.write(result.stdout);process.stderr.write(result.stderr);assert.equal(result.status,0,'current HTTP reader regression failed');console.log('FIX VERIFIED: RPC and upload accept complete framed replies without waiting for socket close');}
