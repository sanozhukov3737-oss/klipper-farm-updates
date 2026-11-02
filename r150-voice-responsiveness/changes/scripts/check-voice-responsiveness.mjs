import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');

const assistant = read('src/lib/voiceAssistant.ts');
assert.match(assistant, /SEMANTIC_TIMEOUT_MS=150_000/, 'semantic interpretation must carry a frontend timeout above the native 120s HTTP deadline');
assert.match(assistant, /withSemanticTimeout/, 'interpret must run behind the timeout guard');
assert.match(assistant, /this\.progress\('semantic','start'\)/, 'semantic interpretation must publish a progress stage');
assert.match(assistant, /error\.name==='TimeoutError'/, 'a lost native reply must resolve with a TimeoutError path');
assert.match(assistant, /'Понимание свободной речи думает слишком долго/u, 'timeout must produce a plain-language reply');

const diagnostics = read('src/lib/voiceDiagnostics.ts');
assert.match(diagnostics, /'command','semantic','search'/, 'semantic stage must be registered in diagnostic stages');
assert.match(diagnostics, /VoiceProgressEvent=\{stage:'semantic'\|/, 'semantic stage must be allowed in progress events');

const stageNames = read('src/components/VoiceDiagnosticsPanel.tsx');
assert.match(stageNames, /semantic:'Понимание свободной речи'/, 'semantic stage must have a Russian label');

const panel = read('src/components/VoiceAssistantPanel.tsx');
assert.match(panel, /Предыдущая команда ещё выполняется/u, 'a command arriving while busy must be answered, not silently dropped');
const silentDrop = panel.match(/if\(busyRef\.current&&intent\.kind!=='cancel'\)\{?\s*return;?\s*\}/);
assert(!silentDrop, 'busy commands must never be dropped silently');

// Behavioural proof: an exact camera command stays immediate, and a resolving
// interpreter publishes its semantic progress stages. The 150-second timeout
// itself is covered statically above (a live wait would stall the suite).
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-responsiveness-')), 'check.mjs');
await build({
  stdin: {
    contents: `
import { VoiceAssistant } from './src/lib/voiceAssistant.ts';
const mk = (id, name, preset) => ({ id, name, host: '192.168.0.10', profile: { preset }, modelSelection: { mode: 'preset', selectedPreset: preset, confirmationRequired: false, pendingPreset: undefined }, status: { state: 'ready', connectionState: 'online', remoteControlSuspended: false, filename: '', printDuration: 0, progress: 0 }, capabilities: { compatible: true } });
const printers = [mk('max', 'K1 Max', 'creality-k1-max'), mk('k1c', 'K1C', 'creality-k1c-2025')];
const events = [];
let cameraId;
const deps = {
  printers: () => printers, canOperate: () => true, client: () => ({}),
  list: async () => [], inventory: async () => ({ items: [] }),
  validate: async () => ({ sha256: '', report: {} }), ready: async () => {},
  upload: async () => 'x', start: async () => {}, check: async () => true, audit: async () => {},
  openCamera: id => { cameraId = id; return true }, hasCamera: () => true,
  progress: event => events.push([event.stage, event.phase]),
};
const instant = new VoiceAssistant(deps);
const cameraReply = await instant.handle('Открой камеру ка один макс');
if (cameraId !== 'max' || !/Открыла окно камеры/u.test(cameraReply.text)) throw new Error('camera command regressed: ' + JSON.stringify(cameraReply));
events.length = 0;
deps.interpret = async () => ({ kind: 'clarify', reason: 'test' });
const free = new VoiceAssistant(deps);
const freeReply = await free.handle('Ксения, покажи, кому сейчас можно дать работу');
const semanticStages = events.filter(([stage]) => stage === 'semantic');
if (semanticStages.length !== 2 || semanticStages[0][1] !== 'start' || semanticStages[1][1] !== 'end') throw new Error('semantic progress stages wrong: ' + JSON.stringify(events));
if (!freeReply.text) throw new Error('free-form reply missing');
console.log('responsiveness behaviour verified');
`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out,
});
await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log('voice responsiveness checks passed');
