import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const walk=directory=>fs.readdirSync(path.join(root,directory),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
const portable=file=>file.replaceAll('\\','/');

const pkg=JSON.parse(read('package.json'));
const tauri=JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo=read('src-tauri/Cargo.toml');
const rust=`${read('src-tauri/src/lib.rs')}
${read('src-tauri/src/upload_commands.rs')}
${read('src-tauri/src/moonraker_protocol.rs')}`;
const authSource=`${read('src-tauri/src/auth_commands.rs')}\n${read('src-tauri/src/moonraker_protocol.rs')}`;
const rustTree=walk('src-tauri/src').map(portable).filter(file=>file.endsWith('.rs')).map(read).join('\n');
const auth=read('src/lib/auth.ts');
const login=read('src/components/LoginPanel.tsx');
const system=read('src/components/SystemPanel.tsx');
const db=read('src/lib/db.ts');
const capabilities=JSON.parse(read('src-tauri/capabilities/default.json'));
const sources=walk('src').map(portable).filter(file=>/\.(ts|tsx)$/.test(file)).map(file=>[file,read(file)]);

assert(pkg.version==='1.14.5','package.json version mismatch');
assert(portable('src\\lib\\auth.ts')==='src/lib/auth.ts','portable path normalization failed');
assert(tauri.version===pkg.version,'Tauri/package versions differ');
assert(new RegExp(`version="${pkg.version.replaceAll('.','\\.')}"`).test(cargo),'Cargo version mismatch');
assert(typeof tauri.app?.security?.csp==='string'&&tauri.app.security.csp.length>80,'production CSP is missing');
assert(!tauri.app.security.csp.includes("'unsafe-eval'"),'unsafe-eval is forbidden');
assert(tauri.app.security.csp.includes("object-src 'none'"),'object-src must be disabled');
// isTauri reads the runtime flag; it does not invoke a native command. Keep
// every other core import behind the authenticated command boundary.
assert(!sources.some(([file,text])=>file!=='src/lib/auth.ts'&&text.replace("import { isTauri } from '@tauri-apps/api/core';",'').includes("from '@tauri-apps/api/core'")),'raw Tauri invoke found outside auth boundary');
assert(!read('src/lib/moonraker.ts').includes('new WebSocket'),'Moonraker must not open WebSocket from WebView');
// Протокол вынесен в rpc.rs (R232): проверяем там, где он теперь живёт, вместе
// с оставшимися в корне authorize_printer_target и rpc_required_role.
const upload=read('src-tauri/src/upload_commands.rs');
const rpcSource=read('src-tauri/src/rpc.rs');
assert(rpcSource.includes('async fn moonraker_ws_rpc')&&rust.includes('authorize_printer_target')&&rpcSource.includes('rpc_required_role(&method'),'native WebSocket must keep printer binding and RPC RBAC');
assert(rust.includes('moonraker_default_port')&&rust.includes('port @ (80 | 7125)'),'WebSocket default-port fallback must remain limited to K1C-compatible ports');
assert(rust.includes('Moonraker sent an invalid masked server frame')&&rust.includes('WebSocket response exceeds the size limit')&&rust.includes('websocket_accept_key'),'native WebSocket framing/handshake hardening is missing');
assert(!read('src/lib/moonraker.ts').includes('thumbnailUrl(')&&read('src/lib/moonraker.ts').includes('thumbnailDataUrl('),'thumbnails must use the authenticated Tauri transport, not direct WebView URLs');
assert(read('src/lib/gcodeThumbnail.ts').includes('imageMimeFromBytes')&&!read('src/lib/gcodeThumbnail.ts').includes('image/svg+xml'),'thumbnail responses must be signature-checked and SVG must remain disabled');
const fetches=sources.flatMap(([file,text])=>[...text.matchAll(/fetch\s*\(/g)].map(()=>file));
assert(fetches.length===0,'WebView network fetch is forbidden');
assert(!read('src/lib/native.ts').includes('secret_get')&&!rustTree.includes('fn secret_get('),'secrets must never be returned to WebView');
assert(read('src/lib/telegram.ts').includes("telegramSendNative(settings.chatId.trim(),text)"),'Telegram must cross only the native command boundary');
assert(rustTree.includes('async fn telegram_send(')&&rustTree.includes('https://api.telegram.org/bot{token}/sendMessage'),'native Telegram transport is missing');
assert(!tauri.app.security.csp.includes('api.telegram.org'),'WebView CSP must not allow direct Telegram access');
assert(rust.includes('PASSWORD_ITERATIONS: u32 = 310_000'),'password work factor changed unexpectedly');
assert(rust.includes('PIN_ITERATIONS: u32 = 310_000')&&authSource.includes('pbkdf2-sha256-pin$')&&authSource.includes('KlipperFarmPIN\\0'),'PIN hashing is missing or not domain-separated');
assert(rust.includes('fn validate_pin')&&rust.includes('pin.len() != 6')&&authSource.includes('auth_pin_login'),'six-digit native PIN login is incomplete');
// Счётчики и блокировка живут в auth_policy (R236/R238). Проверяем смысл —
// порог и длительность блокировки — а не формулировку в конкретном файле.
const policySource=read('src-tauri/src/auth_policy.rs');
assert(/if failure\.count >= 5\s*\{/.test(policySource)&&policySource.includes('5 * 60 * 1000'),'password/PIN lockout changed unexpectedly');
assert(auth.includes("invoke<AuthSession>('auth_pin_login'")&&login.includes('phonePinKeys')&&login.includes("mode==='pin'")&&login.includes('loginWithPin')&&auth.includes('klipper-auth-mode')&&login.includes('preferredLoginMethod'),'phone-style optional PIN UI is not wired to native auth');
assert(system.includes('PIN сейчас включён')&&system.includes('clearPin')&&db.includes('pinEnabled:boolean'),'PIN setup/removal controls are missing');
const backup=rust.slice(rust.indexOf('fn db_backup_json('),rust.indexOf('fn db_restore_json('));
assert(!backup.includes('password_hash')&&!backup.includes('pin_hash'),'credential hashes must not be serialized into backup JSON');
assert(rust.includes('SESSION_IDLE_MS'),'session expiry is missing');
assert(rust.includes('authorize_printer_target'),'printer ID/host binding is missing');
assert(rpcSource.includes('rpc_required_role')&&upload.includes('endpoint_allowed'),'Moonraker allowlists are missing');
assert(rpcSource.includes('should_try_rest_fallback')&&rpcSource.includes('matches!(status, 404 | 405)')&&rpcSource.includes('rpc_error_code == Some(-32601)'),'REST fallback trigger must remain limited to unsupported JSON-RPC transport');
assert(rustTree.includes('assert!(!should_try_rest_fallback(401, None))')&&rustTree.includes('assert!(!should_try_rest_fallback(403, None))'),'REST fallback must not bypass Moonraker authorization failures');
assert(rust.includes('validate_header_value')&&rust.includes('decode_chunked_bytes'),'HTTP hardening is missing');
assert(rust.includes('MAX_UPLOAD')&&rust.includes('MAX_JSON_RESPONSE'),'network size limits are missing');
assert(rust.includes('let io_deadline = Instant::now()')&&rust.includes('saturating_duration_since(Instant::now())'),'absolute Moonraker response deadline is missing');
assert(rpcSource.includes('MOONRAKER_RPC: {message}')&&read('src/lib/auth.ts').includes('/^AUTH_REQUIRED'),'remote RPC errors must not masquerade as a local expired session');
assert(!read('scripts/publish-first-release.sh').includes('leave blank if none'),'blank signing password is still allowed');
assert(capabilities.permissions.every(permission=>permission.startsWith('core:')),'unexpected broad plugin permission');

console.log('security invariants OK: password/PIN auth, shared lockout, RBAC, CSP, Moonraker transport and signing password');
