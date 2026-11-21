import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { registeredNativeCommands, sourceNativeCommands } from './frontend-build-contract.mjs';

const root = path.resolve(import.meta.dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const native = read('src-tauri/src/desktop_background.rs'), entry = read('src-tauri/src/app.rs');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const schema = JSON.parse(read('node_modules/@tauri-apps/cli/config.schema.json'));
assert(schema.definitions.WindowConfig.properties.backgroundThrottling, 'installed Tauri schema must support backgroundThrottling');
assert(schema.definitions.BackgroundThrottlingPolicy.oneOf.some(item => item.enum?.includes('disabled')));
const main = config.app.windows[0];
assert.equal(main.backgroundThrottling, 'disabled');
assert.match(main.additionalBrowserArgs, /(?:^| )--disable-background-timer-throttling(?: |$)/);
assert.match(main.additionalBrowserArgs, /--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection(?: |$)/, 'retain Wry defaults');
for (const command of ['background_mode_get', 'background_mode_set']) {
  assert(registeredNativeCommands(root).includes(command));
  assert(sourceNativeCommands(root).includes(command));
  const body = native.slice(native.indexOf(`fn ${command}(`));
  assert(body.indexOf('require_role(&app, &auth, &session_token, Role::Viewer)?;') < body.indexOf('.0.lock()'), `${command} must authenticate before state access`);
}
assert(entry.includes('.on_window_event(desktop_background::on_window_event)'));
const smokeBranch = entry.slice(entry.indexOf('if smoke_for_setup.is_none()'), entry.indexOf('let watchdog_handle = handle'));
assert(smokeBranch.includes('desktop_background::initialize(&handle)'));
assert(!native.includes('prevent_exit') && !native.includes('.shutdown()'), 'hiding must not intercept explicit update/quit or stop the daemon');
assert(read('src/lib/backgroundActivity.ts').includes("locks.request('klipper-farm.monitoring'"));
assert(read('src/App.tsx').includes('holdMonitoringActivity('), 'existing authenticated WebLock must stay active while hidden');
assert(!read('src-tauri/capabilities/default.json').includes('core:tray:allow'), 'tray is native-owned, without new frontend privileges');

const calls = [], result = { enabled: true, available: true };
globalThis.__backgroundInvoke = async (command, args) => { calls.push({ command, args }); return result; };
const bundle = await build({ entryPoints: [path.join(root, 'src/lib/backgroundMode.ts')], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{
  name: 'authenticated-boundary', setup(builder) {
    builder.onResolve({ filter: /^\.\/auth$/ }, () => ({ path: 'auth', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const secureInvoke=(...args)=>globalThis.__backgroundInvoke(...args)', loader: 'js' }));
  },
}] });
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
assert.equal(await api.backgroundModeGet(), result);
assert.equal(await api.backgroundModeSet(true), result);
assert.equal(await api.backgroundModeSet(false), result);
assert.deepEqual(calls, [{ command: 'background_mode_get', args: undefined }, { command: 'background_mode_set', args: { enabled: true } }, { command: 'background_mode_set', args: { enabled: false } }]);
globalThis.__backgroundInvoke = async () => { throw new Error('AUTH_REQUIRED: expired'); };
await assert.rejects(api.backgroundModeSet(true), /AUTH_REQUIRED/);
delete globalThis.__backgroundInvoke;
console.log('Background contract passed: native auth, current schema, WebView preservation, explicit exits and secure frontend calls');

// Optional Linux harness compiles the actual policy/persistence source and its
// native unit tests without GUI system libraries. Full Tauri compilation and
// actual tray/timer behavior are separately checked on installed Windows.
if (process.argv.includes('--native-harness')) {
  const between = (start, end) => {
    const first = native.indexOf(start), last = native.indexOf(end, first);
    assert(first >= 0 && last > first, `Native source boundary changed: ${start}`);
    return native.slice(first, last);
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-background-tests-'));
  try {
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'Cargo.toml'), '[package]\nname="kf-background-tests"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nrusqlite={version="0.32",features=["bundled"]}\nserde={version="1",features=["derive"]}\nserde_json="1"\n');
    const source = 'use rusqlite::{params,Connection,OptionalExtension};\nuse serde::{Deserialize,Serialize};\nfn now_ms()->i64{0}\n'
      + between('const SETTINGS_KEY:', '#[derive(Default)]\npub(crate) struct BackgroundState')
      + between('fn read_preferences(', 'pub(crate) fn open_main(')
      + native.slice(native.indexOf('#[cfg(test)]\nmod tests'));
    fs.writeFileSync(path.join(directory, 'src/lib.rs'), source);
    const run = spawnSync(process.env.CARGO ?? 'cargo', ['test', '--lib', '--offline', '--manifest-path', path.join(directory, 'Cargo.toml')], { cwd: directory, stdio: 'inherit', env: process.env });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, 'native background policy/persistence tests failed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
