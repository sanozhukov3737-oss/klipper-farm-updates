import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src-tauri/src/online_updates.rs'), 'utf8');
const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const between = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Updater source boundary changed: ${start}`);
  return source.slice(first, last);
};

assert.match(source, /const MAX_INSTALLER: u64 = 512 \* 1024 \* 1024;/, 'existing clients still require a <=512 MiB installer');
assert.match(cargo, /windows-sys=.*"Win32_Storage_FileSystem"/, 'disk query must use the already-enabled Windows API');
const install = between('pub(crate) async fn update_install(', '#[tauri::command]\npub(crate) fn update_cancel(');
const verify = install.indexOf('let value = read_verified(');
const preflight = install.indexOf('ensure_download_space(&directory, value.manifest.artifact.size_bytes)?;');
const download = install.indexOf('fetch(&app, &value.manifest.artifact.url,');
assert(verify >= 0 && preflight > verify && download > preflight, 'verified size must be checked against free space before installer HTTP begins');
const diskQuery = between('#[cfg(windows)]\nfn ensure_download_space(', '#[cfg(not(windows))]');
assert.match(diskQuery, /GetDiskFreeSpaceExW\(\s*path\.as_ptr\(\), &mut available, std::ptr::null_mut\(\), std::ptr::null_mut\(\)\)/, 'use bytes available to this account, including quota restrictions');
assert.match(diskQuery, /check_download_budget\(artifact_bytes, available\)/);
// Скачивание обязано продолжаться с места обрыва, а не начинаться заново: сеть на
// живой ферме даёт от 8.7 МБ/с до нуля, и 285-мегабайтный файл иначе не доехал бы.
assert.match(source, /--continue-at/, 'update download must resume instead of restarting');
assert.match(source, /--retry-all-errors/, 'interrupted transfers must be retried');
assert.match(source, /--speed-limit/, 'a stalled connection must be dropped and reconnected');
// Частичный файл сохраняется для кодов обрыва, иначе докачке нечего продолжать.
assert.match(source, /Some\(18\) \| Some\(28\)/, 'interrupted transfer codes must keep the partial file');
assert.match(source, /return Err\(download_error\(/, 'curl failures must use the write/timeout classification');
console.log('Update download contract passed: signed-size disk preflight precedes HTTP; existing installer limit and cache paths preserved');

// Compile the real pure budget/classification helpers and their native tests
// without Tauri/GUI dependencies. This does not exercise the Windows disk API.
if (process.argv.includes('--native-harness')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-update-download-'));
  try {
    const constants = between('const MAX_INSTALLER:', '#[derive(Deserialize)]');
    const helpers = between('fn required_download_space(', '#[cfg(windows)]\nfn ensure_download_space(');
    const tests = between('mod tests {\n    use super::*;', '    fn snapshot()');
    const rust = path.join(directory, 'download.rs');
    const executable = path.join(directory, process.platform === 'win32' ? 'download.exe' : 'download');
    fs.writeFileSync(rust, `${constants}\n${helpers}\n#[cfg(test)]\n${tests}\n}\n`);
    const compiled = spawnSync(process.env.RUSTC ?? 'rustc', ['--edition=2021', '--test', rust, '-o', executable], { encoding: 'utf8', timeout: 60_000 });
    if (compiled.error) throw compiled.error;
    assert.equal(compiled.status, 0, `Updater helper harness did not compile:\n${compiled.stderr}`);
    const result = spawnSync(executable, ['--nocapture'], { encoding: 'utf8', timeout: 20_000 });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0, 'Updater download budget/classification tests failed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
