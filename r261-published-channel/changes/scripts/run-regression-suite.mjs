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
]);

// A few scripts are checks only with the argument CI passes them. Running the bare form instead would
// prepare or reset something, which a verification pass must not do.
const SCRIPT_ARGUMENTS = new Map([
  ['prepare-windows-build-cache.mjs', ['--self-test']],
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

// Cannot pass on a bare checkout, with the reason measured against all 111 workflow files rather than
// the two that happened to be in one working copy. Each entry says where the check does run, so a skip
// here is not mistaken for a gap in CI.
const NEEDS_EXTERNAL = new Map([
  // Gates for their own historical branches, each triggered only by a change to its own workflow file.
  // The snapshots they compare against are published, but this tree is 30 releases past them.
  ['check-r117-scope.mjs', 'gate for branch main; windows-r117.yml only fires there. The R116 snapshot is published (KF-R116-FULL.zip), but this tree is 30 releases past it'],
  ['check-r118-scope.mjs', 'gate for branch r118-background-panels; windows-r118.yml only fires there. The R117 snapshot is published (KF-R117-FULL.zip)'],
  ['check-r119-scope.mjs', 'gate for branch r119-printer-catalog; windows-r119.yml only fires there. The R118 snapshot is published (KF-R118-FULL.zip)'],
  ['check-r141-performance-report.mjs', 'takes a matched browser report as an argument; referenced by no workflow'],
  // Compiles whisper-worker.exe from whisper-worker.cpp. preview10 runs this on windows-2022 and passes;
  // only a machine without Visual Studio cannot.
  ['check-neural-speech-assets.mjs', 'needs whisper-worker.exe, built with MSVC; preview10 builds it on windows-2022 and passes there'],
  ['check-voice-assets.mjs', 'needs public/voice/ru-small.tar.gz from prepare-voice-model.py and the 46 MB Vosk model; preview10 builds it before running'],
  // preparation needs cmake plus MSVC to build llama.cpp from pinned source, then a 2.33 GB GGUF model
  ['check-voice-understanding-assets.mjs', 'needs assets from prepare-voice-understanding.py, which builds llama.cpp with cmake and MSVC and fetches a 2.33 GB GGUF model; preview10 does this on windows-2022 and passes'],
  // arguments supplied by the job, or tools that are not here
  ['check-headless-telemetry-runtime.mjs', 'takes --daemon pointing at a built klipper-farmd binary; 60 workflows supply it, none on this branch'],
  ['check-windows-gui-binaries.mjs', 'takes DESKTOP_EXE and DAEMON_EXE as arguments; referenced by no workflow'],
  ['check-windows-test-loader.mjs', 'takes a CARGO_JSON_LOG; run-rust-tests.mjs produces one, and this file is what consumes it'],
  ['sign-v20-update.mjs', 'needs KF_UPDATE_ARTIFACT; a publishing step run by hand, referenced by no workflow'],
  ['build-and-install-windows.mjs', 'preview10 runs it with --build-only; locally the optimised crate build dies at rustc-LLVM out of memory'],
  ['verification-lab.mjs', 'aggregator over the checks above, so it inherits their skips; windows-installer.yml runs it, not this branch'],
  ['verification-lab-v20.mjs', 'aggregator over the checks above; referenced by no workflow'],
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
// Exit code 3 means the script could not verify anything — the network was unavailable — and says so on
// stderr. It is reported as a skip rather than a failure, because a check that never reached its subject
// has not failed it, and it is not passed either.
const NOT_VERIFIED = 3;
const notVerified = [];

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
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', entry.name), ...(SCRIPT_ARGUMENTS.get(entry.name) ?? [])], {
      cwd: root, stdio: verbose ? 'inherit' : 'ignore', shell: false, env: environment, timeout: timeoutMs,
    });
    if (result.status === NOT_VERIFIED) {
      notVerified.push({name: entry.name, reason: 'the script reported NOT_VERIFIED: its subject was unreachable'});
      continue;
    }
    results.push({name: entry.name, ok: result.status === 0, ms: Date.now() - started});
    if (result.status !== 0 && !verbose) console.log(`FAIL ${entry.name}`);
    continue;
  }

  if (entry.group === 'clean-tree' && uiTestsReady) {
    skipped.push({name: entry.name, reason: `${entry.reason} (ui-tests/node_modules is installed here)`});
    continue;
  }

  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', entry.name), ...(SCRIPT_ARGUMENTS.get(entry.name) ?? [])], {
    cwd: root,
    stdio: verbose ? 'inherit' : 'ignore',
    shell: false,
    env: {...process.env, CARGO_TERM_COLOR: 'never'},
    timeout: timeoutMs,
  });
  if (result.status === NOT_VERIFIED) {
    notVerified.push({name: entry.name, reason: 'the script reported NOT_VERIFIED: its subject was unreachable'});
    continue;
  }
  const ok = result.status === 0;
  results.push({name: entry.name, ok, ms: Date.now() - started});
  if (!ok) console.log(`FAIL ${entry.name}`);
  else if (verbose) console.log(`pass ${entry.name}`);
}

const failed = results.filter(entry => !entry.ok);
const passed = results.length - failed.length;

for (const entry of skipped) console.log(`SKIP ${entry.name}\n     ${entry.reason}`);
for (const entry of notVerified) console.log(`SKIP ${entry.name}\n     ${entry.reason}`);
console.log('');
console.log(`regression suite: ${passed} passed, ${failed.length} failed, ` +
  `${skipped.length + notVerified.length} skipped ` +
  `(${plan.length - 1} scripts, ${Math.round(results.reduce((total, entry) => total + entry.ms, 0) / 1000)}s)`);
if (failed.length) {
  console.log(`failing: ${failed.map(entry => entry.name).join(', ')}`);
  process.exit(1);
}
process.exit(0);
