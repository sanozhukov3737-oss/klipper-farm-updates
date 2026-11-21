import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file));
const text=file=>read(file).toString('utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const artwork=text('src/lib/printerArtwork.ts');
const app=text('src/App.tsx');
const discoveryPanel=text('src/components/DiscoveryPanel.tsx');
const detector=text('src/lib/printerDetection.ts');
const endpoint=text('src/lib/printerEndpoint.ts');
const moonraker=text('src/lib/moonraker.ts');
const types=text('src/types.ts');
const discoveryRust=text('src-tauri/src/transactional_core/discovery.rs');
const rust=`${text('src-tauri/src/discovery_commands.rs')}\n${text('src-tauri/src/lib.rs')}\n${text('src-tauri/src/moonraker_protocol.rs')}\n${discoveryRust}`;
const cargo=text('src-tauri/Cargo.toml');
const lock=text('src-tauri/Cargo.lock');

assert(artwork.includes("ender-v3-ke-integrated-v2.png"),'Ender-3 V3 KE artwork is not connected');
assert(artwork.includes("flashforge-ad5m-clean-v1144.png"),'clean open-shell FlashForge Adventurer 5M artwork is not connected');
assert(types.includes('interface DiscoveryResult'),'DiscoveryResult frontend type is missing');
assert(app.includes('<DiscoveryPanel ')&&app.includes('onAddAll={addAllDiscovered}'),'non-blocking discovery panel is not wired');
assert(discoveryPanel.includes("secureInvoke<DiscoveryRuntimeResult>('discover_moonraker'")&&discoveryPanel.includes('knownHosts:printersRef.current.map'),'discovery must use the authenticated boundary and saved hosts');
assert(discoveryPanel.includes('result.scanned_subnets')&&discoveryPanel.includes("listen<DiscoveryProgress>('moonraker-discovery-progress'"),'subnets/progress are not shown in the discovery UI');
assert(discoveryPanel.includes("secureInvoke<boolean>('cancel_moonraker_discovery'")&&discoveryPanel.includes('operationRef.current!==id'),'discovery cancellation or stale-result protection is missing');
assert(discoveryPanel.includes('identifyActiveRef.current<3'),'streaming model identification concurrency must remain bounded at three');
assert(discoveryPanel.includes('MAX_IDENTIFY_RESULTS=64')&&discoveryPanel.includes('IDENTIFY_DEADLINE_MS=30_000'),'model identification result/deadline bounds are missing');
assert(discoveryPanel.includes('activeScanSettledRef')&&discoveryPanel.includes('await activeScanSettledRef.current'),'a reopened search can overlap unfinished model probes');
assert(discoveryPanel.includes('startIntentRef.current++')&&discoveryPanel.includes('intent!==startIntentRef.current'),'a waiting/reopened discovery cannot be cancelled safely');
assert(discoveryPanel.includes('if(inFlightRef.current&&operationRef.current)return'),'repeat search can queue another full scan behind the active one');
assert(discoveryPanel.includes('Math.max(current.scanned')&&discoveryPanel.includes('printerEndpointKey'),'parallel progress must be monotonic and default-port endpoints canonicalized');
assert(discoveryPanel.includes("listen<DiscoveryFound>('moonraker-discovery-result'")&&rust.includes('found_callback(printer.clone())'),'each discovery result must stream before the scan completes');
assert(discoveryPanel.includes("secureInvoke<ApiKeyValidation>('validate_moonraker_api_key'")&&discoveryPanel.includes('Moonraker найден · требуется API Key'),'authorization-required discovery flow is missing');
assert(app.includes('await secretSet(configured.id,row.apiKeyForAdd)')&&rust.includes('validate_api_key'),'validated discovery keys are not stored through the native secret boundary');
assert(discoveryPanel.includes('className="discoveryReport"')&&discoveryPanel.includes('diagnostics.entries'),'expandable discovery diagnostics report is missing');
assert(!discoveryPanel.includes('alert(')&&!discoveryPanel.includes('window.alert'),'discovery errors must remain inside the panel');
assert(discoveryPanel.includes('Возможно: ${PRESET_NAMES[candidate]}')&&discoveryPanel.includes("'board.ad5m-level-pins':`контур калибровки ${FLASHFORGE_5M_DISPLAY_NAME}`"),'ambiguous FlashForge discovery hints are not user-facing');
assert(detector.includes('status=\'ambiguous\'')&&detector.includes('fingerprint:fnv1a64'),'versioned model ambiguity/fingerprint engine is missing');
assert(detector.includes('uniqueExplicit.includes(top.model)')&&detector.includes("k1StockMacroCount>=3")&&detector.includes("unsupportedAd5mPro"),'high-confidence identity, stock K1 cluster or unsupported AD5M variant guard is missing');
assert(detector.includes('printerDetectionFactsFromMoonraker')&&detector.includes('const settings=rawSections(configRoot.settings)')&&moonraker.includes("configfile:['settings']"),'structured Moonraker fact boundary is missing');
assert(detector.includes('PRINTER_DETECTION_ENGINE_VERSION = 6')&&detector.includes('geometry.centered-flashforge-220')&&detector.includes('freshAnchors')&&detector.includes('sameDevice'),'v6 centered FlashForge/fresh-identity recognition is missing');
assert(moonraker.includes('settleRequests')&&moonraker.includes('probeCoverage')&&detector.includes('firmware:{...now.firmware}')&&detector.includes('macAddress:value(now.identity?.macAddress')&&!detector.includes('...previous, ...current'),'partial Moonraker probes can still revive stale classifier evidence');
assert(endpoint.includes('explicitPort(trimmed)')&&endpoint.includes('samePrinterEndpoint'),'explicit port/default Moonraker endpoint canonicalization is missing');
assert(app.includes('PRINTER_DETECTION_ENGINE_VERSION')&&app.includes("mode!=='automatic'")&&app.includes('INCOMPLETE_MODEL_RETRY_MS')&&app.includes('for(const printer of stale)'),'bounded stale automatic-model refresh is missing');
const updateStart=app.indexOf('const updateConfig=async');
const updateEnd=app.indexOf('const automaticRefreshKey',updateStart);
const update=app.slice(updateStart,updateEnd);
const addressChangeStart=update.indexOf('if(physicalAddressChanged&&hasStrongPrinterIdentity(cfg.deviceIdentity))');
const metadataStart=update.indexOf('if(updated&&client',addressChangeStart);
assert(addressChangeStart>=0&&metadataStart>addressChangeStart,'physical address verification must be separate from metadata-only settings');
const metadataUpdate=update.slice(metadataStart);
assert(metadataUpdate.includes('client.config=updated')&&!metadataUpdate.includes('clients.current.delete')&&!metadataUpdate.includes('.disconnect()'),'metadata-only settings save must preserve the live Moonraker client');
assert(update.slice(addressChangeStart,metadataStart).includes('return;'),'address verification must finish before the ordinary metadata update path');

const discoveryStart=rust.indexOf('async fn discover_moonraker(');
// Граница функции ищется по следующему определению в том же файле: раньше здесь
// стоял rpc_required_role, но он переехал в rpc.rs (R232).
const cancelAt=rust.indexOf('fn cancel_moonraker_discovery',discoveryStart);
const discoveryEnd=rust.indexOf(String.fromCharCode(10)+'#[tauri::command]',cancelAt>0?cancelAt:discoveryStart);
assert(discoveryStart>=0&&discoveryEnd>discoveryStart,'Rust discovery command is missing');
const discovery=rust.slice(discoveryStart,discoveryEnd);
assert(discovery.includes('require_role(&app, &auth, &session_token, Role::Admin)?'),'discovery lost its Admin authorization check');
assert(discovery.includes('spawn_blocking')&&discovery.includes('discovery.finish'),'discovery must run outside the Tauri command thread and clean up state');
assert(discovery.includes('cancel_moonraker_discovery'),'discovery cancellation command is missing');
assert(rust.includes('if_addrs::get_if_addrs()'),'active adapter enumeration is missing');
assert(rust.includes('interface.is_oper_up()')&&rust.includes('interface.is_p2p()'),'inactive/P2P adapter filtering is missing');
assert(discoveryRust.includes('thread::spawn(move || query_mdns(address, adapter_name))')&&discoveryRust.includes('thread::spawn(move || query_ssdp(address, adapter_name))')&&discoveryRust.includes('thread::spawn(move || query_mdns_v6(index, address, name, bind_ipv4))'),'mDNS/SSDP must fan out across physical IPv4/IPv6 adapters');
assert(rust.includes('Ipv4Addr::new(192, 168, 0, 1)')&&rust.includes('Ipv4Addr::new(192, 168, 1, 1)'),'required fallback subnets are missing');
assert(rust.includes('subnets.truncate(MAX_DISCOVERY_SUBNETS)')&&rust.includes('MAX_DISCOVERY_SUBNETS: usize = 12'),'discovery subnet bound is missing');
assert(rust.includes('DISCOVERY_FAST_WORKERS: usize = 64')&&rust.includes('DISCOVERY_SLOW_WORKERS: usize = 64')&&rust.includes('DISCOVERY_DEADLINE: Duration = Duration::from_secs(9)'),'two-pass discovery concurrency/deadline bounds are missing');
assert(rust.includes('MAX_DISCOVERY_RESULTS: usize = 64')&&rust.includes('dedupe_discovered_printers')&&rust.includes('merged.truncate(MAX_DISCOVERY_RESULTS)'),'discovery result bound or identity-preserving dedupe is missing');
assert(rust.includes('scanned_final < total'),'full discovery scans must not report a false timeout');
assert(rust.includes('http_request(')&&rust.includes('DISCOVERY_FAST_PROBE_TIMEOUT: Duration = Duration::from_millis(240)')&&rust.includes('DISCOVERY_SLOW_PROBE_TIMEOUT: Duration = Duration::from_millis(900)'),'discovery fast/slow HTTP timeouts are not bounded');
assert(rust.includes('MAX_DISCOVERY_ADDRESSES: usize = 3_072')&&rust.includes('parse_manual_discovery_range')&&rust.includes('"retrying"'),'CIDR/manual-range support or slow retry pass is missing');
assert(rust.includes('DISCOVERY_PROGRESS_EVENT: &str = "moonraker-discovery-progress"'),'discovery progress event is missing');
assert(rust.includes('DISCOVERY_FOUND_EVENT: &str = "moonraker-discovery-result"'),'streaming discovery-result event is missing');
assert(rust.includes('printer_info_fallback')&&rust.includes('"/printer/info"'),'discovery must fall back to printer.info on vendor server.info endpoint misses');
const rpcSource=text('src-tauri/src/rpc.rs');
assert(rpcSource.includes('execute_rest_rpc_fallback')&&rpcSource.includes('should_try_rest_fallback(response.status, None)'),'Moonraker REST compatibility fallback is missing');
assert(rpcSource.includes('"printer.objects.query" => json_post("/printer/objects/query")')&&rpcSource.includes('"printer.print.start" => Ok(Some(print_start_fallback(params)?))'),'REST fallback endpoints are incomplete');
assert(rpcSource.includes('objects_query_get_fallback')&&rpcSource.includes('method == "printer.objects.query"')&&rpcSource.includes('matches!(response.status, 400 | 404 | 405 | 415 | 422 | 500 | 501)'),'vendor-fork GET object-query compatibility is missing');
assert(cargo.includes('if-addrs="0.15"'),'if-addrs dependency is missing');
assert(lock.includes('c0a05c691e1fae256cf7013d99dad472dc52d5543322761f83ec8d47eab40d2b'),'if-addrs lock checksum mismatch');

const paeth=(a,b,c)=>{
  const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
  return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
};

function checkRgbaPng(file,expectedHash,expectedSize=900){
  const png=read(file);
  assert(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),`${file}: invalid PNG signature`);
  let offset=8,width=0,height=0,bitDepth=0,colorType=0,interlace=1;
  const idat=[];
  while(offset+12<=png.length){
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+length);
    assert(offset+12+length<=png.length,`${file}: truncated PNG chunk`);
    if(type==='IHDR'){
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];
    }else if(type==='IDAT')idat.push(data);
    offset+=12+length;
    if(type==='IEND')break;
  }
  assert(width===expectedSize&&height===expectedSize,`${file}: expected ${expectedSize}x${expectedSize} artwork`);
  assert((bitDepth===8||bitDepth===16)&&colorType===6&&interlace===0,`${file}: expected non-interlaced RGBA PNG`);
  const bytesPerPixel=4*(bitDepth/8),raw=zlib.inflateSync(Buffer.concat(idat)),stride=width*bytesPerPixel;
  assert(raw.length===height*(stride+1),`${file}: unexpected decoded size`);
  let previous=Buffer.alloc(stride),row=Buffer.alloc(stride),cursor=0;
  const cornerAlpha=[];
  for(let y=0;y<height;y++){
    const filter=raw[cursor++];
    for(let x=0;x<stride;x++){
      const source=raw[cursor++],left=x>=bytesPerPixel?row[x-bytesPerPixel]:0,up=previous[x],upLeft=x>=bytesPerPixel?previous[x-bytesPerPixel]:0;
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,upLeft):-1;
      assert(predictor>=0,`${file}: unsupported PNG filter ${filter}`);
      row[x]=(source+predictor)&255;
    }
    if(y===0||y===height-1){
      if(bitDepth===8)cornerAlpha.push(row[3],row[stride-1]);
      else cornerAlpha.push((row[6]<<8)|row[7],(row[stride-2]<<8)|row[stride-1]);
    }
    [previous,row]=[row,previous];
  }
  const transparentThreshold=bitDepth===8?1:257;
  assert(cornerAlpha.every(alpha=>alpha<=transparentThreshold),`${file}: corner pixels must be transparent`);
  assert(crypto.createHash('sha256').update(png).digest('hex')===expectedHash,`${file}: SHA-256 mismatch`);
}

checkRgbaPng('src/assets/ender-v3-ke-integrated-v2.png','b02ea26d942e2fdde070fbe19446307f56da2269be663aac8774afafe8ce719a',1280);
checkRgbaPng('src/assets/flashforge-ad5m-clean-v1144.png','c82420d77620217fe60075b07af2003d99beae49f6ce697557485331334e072b',1254);

checkRgbaPng('src/assets/creality-k1c-clean-v1144.png','bfb3aa3118ef9651d134f7df5b2858379d706f4462f94be7bdb5027e9804dea7',1280);
checkRgbaPng('src/assets/creality-k1-max-neon-v114.png','1a83cc813bdcc714addb2c785c607771aee85ee8a31c73acce2eb066757ca419',1280);

console.log('search/art OK: authenticated multi-subnet discovery and verified transparent artwork');
