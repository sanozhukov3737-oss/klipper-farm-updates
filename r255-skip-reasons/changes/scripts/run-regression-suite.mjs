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

// Not checks: these produce the files other checks read. Running them during a verification pass
// would mean the pass mutates the tree it is measuring, and prepare-voice-runtime additionally fails
// if public/voice/ is absent — it writes into that directory rather than creating it.
const PREPARES = new Set([
  'prepare-camera-detector.mjs',
  'prepare-sidecar.mjs',
  'prepare-voice-runtime.mjs',
  'prepare-windows-build-cache.mjs',
]);

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
  // These three are gates for their own historical branches. windows-r117.yml only fires on main,
  // windows-r118.yml only on r118-background-panels, windows-r119.yml only on r119-printer-catalog —
  // and each only when its own workflow file changes. They compare the tree against a released
  // snapshot that no asset carries, and against code 30 releases old, so they are not runnable here
  // by design rather than by missing setup.
  ['check-r117-scope.mjs', 'gate for branch main against R116: the snapshot exists (KF-R116-FULL.zip on release r116) but 46 src and 26 src-tauri files changed across the 30 releases since, against 7 allowed'],
  ['check-r118-scope.mjs', 'gate for branch r118-background-panels against R117 (KF-R117-FULL.zip exists on release r117); this tree is 30 releases past that snapshot'],
  ['check-r119-scope.mjs', 'gate for branch r119-printer-catalog against R118 (KF-R118-FULL.zip exists on release r118); this tree is 30 releases past that snapshot'],
  ['check-module-refactor.mjs', 'baseline is obtainable (KF-R142-FULL.zip on release r142) and the check does run against it, but it asserts the extracted module is byte-identical to the r142 block: the module grew from 18 to 29 functions since, and two bodies gained a reported-rollback fix in a later release'],
  ['check-r141-performance-report.mjs', 'takes a matched browser report as an argument by design; not called by any workflow'],
  // Runs in CI, which is where the worker gets compiled: the workflow builds whisper-worker.exe with
  // MSVC before calling this. Only a developer machine without Visual Studio cannot.
  ['check-neural-speech-assets.mjs', 'needs src-tauri/speech/whisper/whisper-worker.exe; this machine has no MSVC, CI compiles it on windows-2022 and runs this check there'],
  ['check-voice-assets.mjs', 'needs public/voice/ru-small.tar.gz, produced by prepare-voice-model.py from the 46 MB Vosk model; CI builds it before this runs'],
  ['check-voice-understanding-assets.mjs', 'needs an understanding manifest from prepare-voice-understanding.py, which requires a bundled interpreter; not called by any workflow'],
  // These two do run in CI, with their arguments supplied by the job.
  ['check-windows-gui-binaries.mjs', 'takes DESKTOP_EXE and DAEMON_EXE as arguments; CI supplies the built binaries'],
  ['check-headless-telemetry-runtime.mjs', 'takes --daemon pointing at a built klipper-farmd binary; CI supplies it'],
  ['check-windows-test-loader.mjs', 'takes a CARGO_JSON_LOG as an argument by design; not called by any workflow'],
  ['sign-v20-update.mjs', 'needs KF_UPDATE_ARTIFACT; not called by any workflow, it is a publishing step run by hand'],
  ['build-and-install-windows.mjs', 'builds and installs the Windows release; not a source check — locally it dies at rustc-LLVM out of memory during the optimised crate build'],
  ['prepare-windows-build-cache.mjs', 'requires CARGO_TARGET_DIR strictly inside KF_CACHE_ROOT'],
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
  if (PREPARES.has(name)) return {name, group: 'prepare', reason: 'creates the files other checks read; run it as a preparation step, not as verification'};
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
  if (entry.group === 'prepare') {
    skipped.push({name: entry.name, reason: entry.reason});
    continue;
  }
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
