import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const baseline=process.argv.includes('--expect-baseline-failure');
// RPC-путь вынесен в rpc.rs (R232), отмена осталась в lib.rs. Собираем оба:
// границы ищутся по тексту, и структура с функциями должны быть в одном наборе.
// Обрезаем файл после creduce: inner-атрибуты (#![...]) и mod-объявления
// допустимы только в начале файла, а мы склеиваем два.
const bodyOf=text=>text.replace(/^#!\[[^\]]*\]\s*$/gm,'');
const main=[
  fs.readFileSync(path.join(root,'src-tauri/src/rpc.rs'),'utf8'),
  bodyOf(fs.readFileSync(process.env.KF_RPC_BASELINE||path.join(root,'src-tauri/src/lib.rs'),'utf8')),
].join(String.fromCharCode(10));
const protocol=fs.readFileSync(path.join(root,'src-tauri/src/moonraker_protocol.rs'),'utf8');
const extract=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a);assert.ok(a>=0&&b>a,`missing source boundary ${start}`);return text.slice(a,b)};
// rpc.rs вставляется целиком: вырезать по кускам нельзя — функции внутри него
// ссылаются друг на друга, и границы пришлось бы описывать для каждой.
// Из rpc.rs берём только те функции, что нужны транспортному пути. Целиком
// файл вставить нельзя: он тянет tauri, kf_moonraker и engine_client.
const rpcRaw=fs.readFileSync(path.join(root,'src-tauri/src/rpc.rs'),'utf8');
const grab=(start,end)=>{const a=rpcRaw.indexOf(start),b=rpcRaw.indexOf(end,a);assert.ok(a>=0&&b>a,'rpc boundary '+start);return rpcRaw.slice(a,b)};
const rpcHelpers=[
  grab('pub(crate) fn rpc_required_role(','pub(crate) fn rpc_params_body('),
  grab('pub(crate) fn rpc_params_body(','pub(crate) fn rpc_without_params('),
  grab('pub(crate) fn rpc_without_params(','pub(crate) fn moonraker_query_result_useful('),
  grab('pub(crate) fn moonraker_query_result_useful(','#[derive(Debug, PartialEq, Eq)]'+String.fromCharCode(10)+'pub(crate) struct RestRpcFallback'),
  grab('pub(crate) fn should_try_rest_fallback(','pub(crate) fn should_try_query_compatibility_fallback('),
  grab('pub(crate) fn should_try_query_compatibility_fallback(','pub(crate) fn bounded_rpc_timeout('),
  grab('pub(crate) fn bounded_rpc_timeout(','pub(crate) fn bounded_http_timeout('),
  grab('pub(crate) fn bounded_http_timeout(','pub(crate) fn queue_delete_fallback('),
  grab('pub(crate) fn queue_delete_fallback(','pub(crate) fn files_list_fallback('),
  grab('pub(crate) fn files_list_fallback(','pub(crate) fn files_move_fallback('),
  grab('pub(crate) fn files_move_fallback(','pub(crate) fn objects_query_get_fallback('),
  grab('pub(crate) fn objects_query_get_fallback(','pub(crate) fn print_start_fallback('),
  rpcRaw.slice(rpcRaw.indexOf('pub(crate) fn print_start_fallback(')),
  grab('pub(crate) fn rest_fallback_for_rpc(','pub(crate) fn parse_moonraker_result('),
  grab('pub(crate) fn parse_moonraker_result(','pub(crate) fn should_try_rest_fallback('),
].join(String.fromCharCode(10));
const routes=grab('#[derive(Debug, PartialEq, Eq)]'+String.fromCharCode(10)+'pub(crate) struct RestRpcFallback','pub(crate) async fn rpc_async(');
const rpc=grab('pub(crate) async fn rpc_async(','pub(crate) fn rpc_blocking(');
const fallbackSync=grab('pub(crate) fn execute_rest_rpc_fallback(','pub(crate) async fn execute_rest_rpc_fallback_async(');
const fallback=grab('pub(crate) async fn execute_rest_rpc_fallback_async(','pub(crate) async fn moonraker_rpc(');


const parser=extract(protocol,'pub(crate) fn decode_chunked_bytes(','pub(crate) fn http_request(');
const http=extract(protocol,'pub(crate) async fn http_request_async(','pub(crate) fn bounded_connect_timeout(');
// Вставленные функции должны быть видимы внутри каркаса без pub(crate):
// внутри fn модификатор видимости недопустим.
// Каркас объявляет свои HttpTarget/HttpResponse/MAX_JSON_RESPONSE и use-строки:
// у вставленного rpc.rs они должны исчезнуть, иначе E0252.
const visible=text=>text
  .replace(/pub\(crate\)\s+/g,'')
  .replace(/^use [\s\S]*?;$/gm,'')
  .replace(/^\/\/!.*$/gm,'')
  .replace(/^#\[tauri::command\]$/gm,'')
  .replace(/^(struct|const) (HttpTarget|HttpResponse|MAX_JSON_RESPONSE).*$/gm,'');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'kf-native-rest-rpc-'));fs.mkdirSync(path.join(temporary,'src'));
fs.writeFileSync(path.join(temporary,'Cargo.toml'),`[package]\nname="kf-native-rest-rpc-regression"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nkf-moonraker={path=${JSON.stringify(path.join(root,'src-tauri/crates/kf-moonraker').replaceAll('\\','/'))}}\ntokio={version="1.53.1",features=["rt-multi-thread","sync"]}\nserde_json="1"\nurl="2"\n`);
const harness=String.raw`
#![allow(dead_code,unused_imports)]
use std::{collections::HashMap,net::SocketAddr,time::Duration};
struct HttpTarget{socket:SocketAddr,authority:String}
struct HttpResponse{status:u16,content_type:Option<String>,body:Vec<u8>}
const MAX_JSON_RESPONSE:usize=2*1024*1024;
fn parse_target(host:&str,_port:u16)->Result<HttpTarget,String>{Ok(HttpTarget{socket:host.parse().unwrap(),authority:host.into()})}
// Заглушки: extracted-код ссылается на помощники, которые остались в других
// модулях. Здесь они не проверяются — проверяется транспортный путь.
#[allow(unused)]
struct AppHandle;
#[allow(unused)]
struct AppUser{role:String}
#[allow(unused)]
fn bounded_spawn_blocking<F:FnOnce()->T+Send+'static,T:Send+'static>(_c:(),_f:F)->impl std::future::Future<Output=Result<T,String>>{async{Err("stub".into())}}
#[allow(unused)]
fn engine_owner_conflict(_e:&str)->bool{false}
#[allow(unused)]
fn authorize_printer_target(_a:&AppHandle,_u:&AppUser,_p:&str,_h:&str)->Result<(),String>{Ok(())}
#[allow(unused)]
fn parse_role(_v:&str)->Result<Role,String>{Ok(Role::Admin)}
#[allow(unused)]
fn moonraker_default_port(_v:Option<u16>)->u16{7125}
#[allow(unused)]
fn http_request(_t:&HttpTarget,_m:&str,_p:&str,_k:Option<&str>,_c:Option<&str>,_b:&[u8],_m2:usize,_d:Duration)->Result<HttpResponse,String>{Err("stub".into())}
#[allow(unused)]
#[derive(Clone,PartialEq,Eq,Debug)]
enum Role{Admin,Operator,Viewer}
#[allow(unused)]
struct AuthState;
#[allow(unused)]
struct State<'a,T>(std::marker::PhantomData<&'a T>);
#[allow(unused)]
#[derive(Clone,Copy)]
enum ExecutionClass{Control,ActorIo,FileIo}
fn header_boundary(raw:&[u8])->Option<usize>{raw.windows(4).position(|v|v==b"\r\n\r\n")}
fn validate_header_value(value:&str,_maximum:usize)->Result<(),String>{if value.contains(['\r','\n']){Err("invalid header".into())}else{Ok(())}}
PARSER
mod moonraker_protocol{use super::*;HTTP}
ROUTES



#[test]fn actual_async_rpc_vendor_404_fallback_and_no_unsafe_replays(){
 use std::io::{Read,Write};
 let cases:Vec<&str>=if BASELINE{vec!["move-404"]}else{vec!["move-404","move-methodmissing","move-401","move-403","move-500","move-disconnect","move-timeout","move-rest404","move-jsonrpc-ok","start-404","query-404","info-404"]};
 for case in cases{
  let method=if case.starts_with("start"){"printer.print.start"}else if case.starts_with("query"){"printer.objects.query"}else if case.starts_with("info"){"server.info"}else{"server.files.move"};
  let params=match method{"printer.print.start"=>Some(serde_json::json!({"filename":"folder/part & test.gcode"})),"printer.objects.query"=>Some(serde_json::json!({"objects":{"print_stats":null}})),"server.info"=>None,_=>Some(serde_json::json!({"source":"gcodes/kf-stage.gcode","dest":"gcodes/папка/part & test.gcode"}))};
  let expected=if BASELINE||matches!(case,"move-401"|"move-403"|"move-500"|"move-disconnect"|"move-timeout"|"move-jsonrpc-ok"){1}else if case=="query-404"{3}else{2};
  let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let socket=listener.local_addr().unwrap();
  let server=std::thread::spawn(move||{
   for index in 0..expected{
    listener.set_nonblocking(true).unwrap();let deadline=std::time::Instant::now()+Duration::from_secs(5);
    let mut stream=loop{match listener.accept(){Ok((s,_))=>break s,Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{assert!(std::time::Instant::now()<deadline,"missing REST request {case}");std::thread::sleep(Duration::from_millis(5))},Err(e)=>panic!("{e}")}};
    stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();let mut raw=Vec::new();let mut block=[0;4096];
    let (end,length)=loop{let n=stream.read(&mut block).unwrap();assert!(n>0);raw.extend_from_slice(&block[..n]);if let Some(end)=header_boundary(&raw){let head=String::from_utf8_lossy(&raw[..end]);let length=head.lines().find_map(|l|l.strip_prefix("Content-Length: ")).map(|v|v.trim().parse::<usize>().unwrap()).unwrap_or(0);break(end+4,length)}};
    while raw.len()<end+length{let n=stream.read(&mut block).unwrap();assert!(n>0);raw.extend_from_slice(&block[..n])}
    let head=String::from_utf8_lossy(&raw[..end]);let line=head.lines().next().unwrap();
    if case=="move-disconnect"{continue;}
    if case=="move-timeout"{std::thread::sleep(Duration::from_millis(1200));continue;}
    let (status,body)=if index==0{
     assert_eq!(line,"POST /server/jsonrpc HTTP/1.1");
     let request:serde_json::Value=serde_json::from_slice(&raw[end..end+length]).unwrap();assert_eq!(request["method"],method);
     match case{"move-401"=>(401,r#"{"error":{"message":"Unauthorized"}}"#),"move-403"=>(403,r#"{"error":{"message":"Forbidden"}}"#),"move-500"=>(500,r#"{"error":{"message":"Server error"}}"#),"move-methodmissing"=>(200,r#"{"error":{"code":-32601,"message":"Method not found"}}"#),"move-jsonrpc-ok"=>(200,r#"{"result":{"item":{"path":"part.gcode"}}}"#),_=>(404,r#"{"error":{"code":404,"message":"Method not found"}}"#)}
    }else if method=="server.files.move"{
     assert!(line.starts_with("POST /server/files/move?"));assert_eq!(length,0);
     let path=line.split_whitespace().nth(1).unwrap();let args=url::form_urlencoded::parse(path.split_once('?').unwrap().1.as_bytes()).into_owned().collect::<HashMap<_,_>>();
     assert_eq!(args["source"],"gcodes/kf-stage.gcode");assert_eq!(args["dest"],"gcodes/папка/part & test.gcode");
     if case=="move-rest404"{(404,r#"{"error":{"message":"file not found"}}"#)}else{(200,r#"{"result":{"item":{"path":"part.gcode"}}}"#)}
    }else if method=="printer.print.start"{
     assert!(line.starts_with("POST /printer/print/start?filename=folder%2Fpart+%26+test.gcode "));(200,r#"{"result":"ok"}"#)
    }else if method=="printer.objects.query"&&index==1{
     assert_eq!(line,"POST /printer/objects/query HTTP/1.1");(405,r#"{"error":{"message":"GET required"}}"#)
    }else if method=="printer.objects.query"{
     assert_eq!(line,"GET /printer/objects/query?print_stats HTTP/1.1");(200,r#"{"result":{"status":{"print_stats":{"state":"printing","filename":"part.gcode"}}}}"#)
    }else{assert_eq!(line,"GET /server/info HTTP/1.1");(200,r#"{"result":{"nexusp_version":"v0.1.1","klippy_connected":true}}"#)};
    write!(stream,"HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
   }
   listener.set_nonblocking(true).unwrap();assert!(listener.accept().is_err(),"unexpected replay");
  });
  let runtime=tokio::runtime::Runtime::new().unwrap();
  let result=runtime.block_on(rpc_async(socket.to_string(),None,method.into(),params,false,Some(if case=="move-timeout"{1000}else{3000}),7125,kf_moonraker::CancellationToken::default()));
  server.join().unwrap();
  if BASELINE{assert!(result.unwrap_err().contains("404"));println!("OLD NATIVE PATH REPRODUCED: move fails HTTP404 and never reaches the REST endpoint");}
  else if matches!(case,"move-401"|"move-403"|"move-500"|"move-disconnect"|"move-timeout"|"move-rest404"){assert!(result.is_err(),"{case} falsely confirmed");}
  else{assert!(result.is_ok(),"{case}: {result:?}");}
 }
}
`.replace('\nPARSER\n','\n'+parser+'\n').replace('HTTP}',http+'}').replace('\nROUTES\n','\n'+visible(rpcHelpers)+String.fromCharCode(10)+visible(routes)+String.fromCharCode(10)+visible(rpc)+String.fromCharCode(10)+visible(fallbackSync)+String.fromCharCode(10)+visible(fallback)+'\n').replaceAll('BASELINE',String(baseline));
fs.writeFileSync(path.join(temporary,'src/lib.rs'),harness);if(process.env.KF_KEEP_HARNESS)fs.writeFileSync(process.env.KF_KEEP_HARNESS,harness);
const result=spawnSync('cargo',['test','--offline','--manifest-path',path.join(temporary,'Cargo.toml'),'--','--nocapture'],{cwd:root,encoding:'utf8',timeout:120_000,env:{...process.env,CARGO_TARGET_DIR:process.env.CARGO_TARGET_DIR??path.join(root,'src-tauri/target')}});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');assert.equal(result.status,0,`actual REST RPC regression failed: ${result.error??''}`);
console.log(baseline?'Published native RPC failure reproduced':'PASS actual native async RPC: move/info/start/query without HTTP JSON-RPC, auth and server errors never replay, REST404 remains an error');
fs.rmSync(temporary,{recursive:true,force:true});
