#!/usr/bin/env node
/**
 * Runs the regression scripts the way CI does — in separate environments, not one.
 *
 * The CI workflow splits these checks across jobs: system-panel-layout installs ui-tests dependencies
 * and runs the browser checks, while linux-gates runs check-release-portability over a tree that has no
 * ui-tests/node_modules at all. Running all 162 scripts in a single shell mixes those environments and
 * reports failures that CI never sees: installing playwright under ui-tests/ makes
 * check-release-portability reject the tree, and the two browser checks want different variables from
 * each other.
 *
 * So this runner groups them, and states the reason whenever it declines to run one. A skip is always
 * printed with why it happened — silence would be worse than the false failures it replaces.
 *
 * Usage:
 *   node scripts/run-regression-suite.mjs            # all groups that the environment supports
 *   node scripts/run-regression-suite.mjs --list      # print the plan and exit
 *   node scripts/run-regression-suite.mjs --verbose   # show passing scripts too
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const arguments_ = process.argv.slice(2);
const listOnly = arguments_.includes('--list');
const verbose = arguments_.includes('--verbose');
const timeoutMs = Number(process.env.KF_SUITE_TIMEOUT_MS ?? 500_000);

// Long-lived services. These listen until something external stops them, so a runner must not treat
// their timeout as a failure; they are started by hand when someone is testing against them.
const DAEMONS = new Set([
  'hardware-emulator.mjs',
  'soak-v20-6-discovery.mjs',
]);

// Need ui-tests dependencies installed and a Playwright browser. system-panel-layout does exactly this
// (`npm ci --prefix ui-tests`, `npx playwright install chromium`) before running them.
const UI_TESTS = new Map([
  ['check-background-camera-browser-r118.mjs', 'needs Playwright from ui-tests/node_modules and a browser; also needs PLAYWRIGHT_MODULE_PATH pointing at it'],
  ['compact-theme-styles.mjs', 'needs a Playwright browser; it resolves the module itself, so PLAYWRIGHT_MODULE_PATH must stay unset'],
]);

// Cannot pass on a bare checkout no matter how the shell is configured. Each reason is the actual
// blocker, measured rather than guessed, so the skip is checkable.
const NEEDS_EXTERNAL = new Map([
  ['check-r117-scope.mjs', 'needs KF_R117_BASELINE: a verified snapshot of the published R116 source, which no release asset carries'],
  ['check-r118-scope.mjs', 'needs KF_R118_BASELINE: a verified snapshot of the published R117 source, which no release asset carries'],
  ['check-r119-scope.mjs', 'needs KF_R119_BASELINE: a verified snapshot of the published R118 source, which no release asset carries'],
  ['check-module-refactor.mjs', 'needs KF_R142_BASELINE: the r142 baseline source tree'],
  ['check-r141-performance-report.mjs', 'needs the actual matched R141 browser report supplied as an argument'],
  ['check-neural-speech-assets.mjs', 'needs src-tauri/speech/whisper/whisper-worker.exe, compiled from whisper-worker.cpp with MSVC, which this machine does not have'],
  ['check-voice-understanding-assets.mjs', 'needs an understanding manifest produced by prepare-voice-understanding.py, which requires a bundled interpreter that is not present'],
  ['check-windows-gui-binaries.mjs', 'takes DESKTOP_EXE and DAEMON_EXE as arguments by design'],
  ['check-windows-test-loader.mjs', 'takes a CARGO_JSON_LOG as an argument by design'],
  ['check-headless-telemetry-runtime.mjs', 'takes --daemon pointing at a built klipper-farmd binary by design'],
  ['sign-v20-update.mjs', 'needs KF_UPDATE_ARTIFACT, produced by the release build'],
  ['build-and-install-windows.mjs', 'packages and installs the Windows build; part of the release job, not a source check'],
  ['prepare-windows-build-cache.mjs', 'requires CARGO_TARGET_DIR to sit strictly inside KF_CACHE_ROOT'],
  ['verification-lab.mjs', 'aggregator that re-runs the checks above, so it inherits their skips'],
  ['verification-lab-v20.mjs', 'aggregator that re-runs the checks above, so it inherits their skips'],
]);

// Checks that require an untouched tree: they walk every file and reject anything that is not valid
// portable text. ui-tests/node_modules trips that, which is why CI runs them in a job that never installs
// it. Declared here so the runner can say so instead of reporting a failure no job would see.
const NEEDS_CLEAN_TREE = new Map([
  ['check-release-portability.mjs', 'walks the whole tree; ui-tests/node_modules makes it fail, and in CI it runs in a job that does not install that dependency'],
]);

const scripts = fs.readdirSync(path.join(root, 'scripts'))
  .filter(name => name.endsWith('.mjs'))
  .sort();

const plan = scripts.map(name => {
  if (name === 'run-regression-suite.mjs') return {name, group: 'self'};
  if (DAEMONS.has(name)) return {name, group: 'daemon'};
  if (UI_TESTS.has(name)) return {name, group: 'ui-tests', reason: UI_TESTS.get(name)};
  if (NEEDS_EXTERNAL.has(name)) return {name, group: 'external', reason: NEEDS_EXTERNAL.get(name)};
  if (NEEDS_CLEAN_TREE.has(name)) return {name, group: 'clean-tree', reason: NEEDS_CLEAN_TREE.get(name)};
  return {name, group: 'source'};
});

const counts = plan.reduce((accumulator, entry) => {
  accumulator[entry.group] = (accumulator[entry.group] ?? 0) + 1;
  return accumulator;
}, {});

if (listOnly) {
  for (const entry of plan) {
    console.log(`${entry.group.padEnd(9)} ${entry.name}${entry.reason ? `\n          ${entry.reason}` : ''}`);
  }
  console.log(`\n${scripts.length} scripts: source ${counts.source ?? 0}, ui-tests ${counts['ui-tests'] ?? 0}, ` +
    `external ${counts.external ?? 0}, daemons ${counts.daemon ?? 0}`);
  process.exit(0);
}

const uiTestsReady = fs.existsSync(path.join(root, 'ui-tests', 'node_modules', 'playwright'));
const results = [];
const skipped = [];

for (const entry of plan) {
  if (entry.group === 'self') continue;
  if (entry.group === 'daemon') {
    skipped.push({name: entry.name, reason: 'long-lived service, started by hand rather than run to a timeout'});
    continue;
  }
  if (entry.group === 'external') {
    skipped.push({name: entry.name, reason: entry.reason});
    continue;
  }
  if (entry.group === 'ui-tests') {
    if (!uiTestsReady) {
      skipped.push({name: entry.name, reason: `${entry.reason} (ui-tests/node_modules is not installed)`});
      continue;
    }
    // The browser checks disagree about PLAYWRIGHT_MODULE_PATH, so it is set only for the one that wants it.
    const environment = {...process.env, CARGO_TERM_COLOR: 'never'};
    if (entry.name === 'check-background-camera-browser-r118.mjs') {
      environment.PLAYWRIGHT_MODULE_PATH = path.join(root, 'ui-tests', 'node_modules', 'playwright', 'index.mjs');
    } else {
      delete environment.PLAYWRIGHT_MODULE_PATH;
    }
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', entry.name)], {
      cwd: root, stdio: verbose ? 'inherit' : 'ignore', shell: false, env: environment, timeout: timeoutMs,
    });
    results.push({name: entry.name, ok: result.status === 0, ms: Date.now() - started});
    if (result.status !== 0 && !verbose) console.log(`FAIL ${entry.name}`);
    continue;
  }

  if (entry.group === 'clean-tree' && uiTestsReady) {
    skipped.push({name: entry.name, reason: `${entry.reason} (ui-tests/node_modules is installed here)`});
    continue;
  }

  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', entry.name)], {
    cwd: root,
    stdio: verbose ? 'inherit' : 'ignore',
    shell: false,
    env: {...process.env, CARGO_TERM_COLOR: 'never'},
    timeout: timeoutMs,
  });
  const ok = result.status === 0;
  results.push({name: entry.name, ok, ms: Date.now() - started});
  if (!ok) console.log(`FAIL ${entry.name}`);
  else if (verbose) console.log(`pass ${entry.name}`);
}

const failed = results.filter(entry => !entry.ok);
const passed = results.length - failed.length;

for (const entry of skipped) console.log(`SKIP ${entry.name}\n     ${entry.reason}`);
console.log('');
console.log(`regression suite: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped ` +
  `(${plan.length - 1} scripts, ${Math.round(results.reduce((total, entry) => total + entry.ms, 0) / 1000)}s)`);
if (failed.length) {
  console.log(`failing: ${failed.map(entry => entry.name).join(', ')}`);
  process.exit(1);
}
process.exit(0);
