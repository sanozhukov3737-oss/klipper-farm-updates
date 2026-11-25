import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registeredNativeCommands } from './frontend-build-contract.mjs';

// The lib.rs split is finished. r242 extracted the database commands, r243 the app bootstrap, r245 the
// upload path, r246 the library files and r247 the role checks and the library root. This check now
// guards the result rather than the act: every module it covers was verified once against the code it
// replaced, and from then on it must not drift without someone deciding it should.
//
// The baseline is the tree as it stood immediately after r247, committed beside the code as
// r247-module-baseline/ so the check needs no network, no release asset and no external checkout.
// Moving it forward is a deliberate act: replace the directory in an overlay and say why in the message.
//
// The baseline holds two source files and a JSON list of the 115 registered command names. It does not
// hold lib.rs: that file embeds APP_VERSION, which the release stamp rewrites, so a copy of it in the
// tree trips the version audit before the native build even starts.
const root = path.resolve(import.meta.dirname, '..');
const baseline = path.resolve(
  process.env.KF_MODULE_BASELINE ?? process.argv[2] ?? path.join(root, 'r247-module-baseline'),
);
const read = (base, file) => fs.readFileSync(path.join(base, file), 'utf8');

function identical(relative, label) {
  const expected = read(baseline, relative);
  const actual = read(root, relative);
  assert.equal(actual, expected, `${label} drifted from the r247 baseline: ${relative}`);
  return { text: expected, sha256: crypto.createHash('sha256').update(expected).digest('hex') };
}

// The library commands moved out of lib.rs wholesale, so the module is the unit to protect. A change
// here is either an intended edit — in which case the baseline moves with it and the message says so —
// or an accident this check exists to catch.
const library = identical('src-tauri/src/local_library_commands.rs', 'Local-library command module');
const libraryNames = [...new Set([...library.text.matchAll(/(?:async )?fn (local_library_\w+)\(/g)].map(m => m[1]))];
assert.equal(libraryNames.length, 18, 'Local-library command module no longer has its 18 functions');

// The actor bridge left moonraker.ts for its own file. Protecting the file is now precise: the original
// check had to slice the block out of a 135 KB client and rebuild the file to compare it.
const bridge = identical('src/lib/printerActorBridge.ts', 'Printer actor bridge');
assert.ok(bridge.text.includes('export type PrinterActorPhase='), 'Actor bridge no longer declares PrinterActorPhase');

// Every local-library command must still be reachable from invoke_handler under its own name. This is
// what makes the extraction safe: the module carries the bodies, lib.rs carries the registration.
// Two of the eighteen functions are internal helpers and are deliberately not commands.
const INTERNAL_HELPERS = new Set(['local_library_files_equal', 'local_library_root']);
const registration = read(root, 'src-tauri/src/lib.rs');
let registeredCommands = 0;
for (const name of libraryNames) {
  const registered = new RegExp(`(?:^|[\\s,(])local_library_commands::${name}\\s*[,)]`, 'm').test(registration);
  if (INTERNAL_HELPERS.has(name)) {
    assert.ok(!registered, `Internal helper must not be exposed as a command: ${name}`);
    continue;
  }
  assert.ok(registered, 'Native command is no longer registered: ' + name);
  registeredCommands += 1;
}
assert.equal(registeredCommands, 16, 'Expected 16 registered local-library commands');

// The published command surface must be exactly what it was before the split, so no rebinding changed
// what the frontend can call. It is stored as a sorted name list rather than as the historical lib.rs:
// that file carries APP_VERSION, which stamp-version.py has to rewrite, so keeping a copy of it in the
// tree would fail the version audit. The names are what this check compares, so the names are what it
// keeps.
const expectedSurface = JSON.parse(read(baseline, 'native-commands.json'));
const surface = registeredNativeCommands(root);
assert.deepEqual(surface, expectedSurface, 'Native command surface changed since r247');
assert.equal(surface.length, 115, 'Native command surface is no longer 115 commands');

console.log(JSON.stringify({
  passed: true,
  baseline: path.basename(baseline),
  nativeCommands: surface.length,
  libraryFunctions: libraryNames.length,
  registeredCommands,
  libraryModuleSha256: library.sha256,
  actorBridgeSha256: bridge.sha256,
  note: 'modules byte-identical to the verified r247 extraction; move the baseline deliberately',
}));
