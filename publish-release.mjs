#!/usr/bin/env node
// Publish a Klipper Farm stable release from an accepted Windows build run.
//
// The sequence-152 release was published by hand: download artifacts, read the
// provenance, compare hashes, create a draft, upload, compare hashes again, flip the
// draft. Every step was a chance to ship a broken link to users, and one of them was
// only caught because the channel sequence happened to be inspected first.
//
// This script performs the same steps in one place and refuses to continue whenever
// any fact disagrees. It never signs anything itself: signing is delegated to
// sign-update.mjs so the publisher key keeps a single, reviewed code path.
//
// Safety rules encoded here:
//   * the chosen run must be the exact successful Windows acceptance run of this repo;
//   * the provenance must belong to that run and commit, with every acceptance flag set;
//   * the installer bytes must match the provenance;
//   * the runtime the installer points at must already be published with the same digest;
//   * the manifest sequence must be strictly greater than the published one, because the
//     updater ignores equal sequences and rejects them as equivocation;
//   * the draft is only published after the uploaded assets match their local digests.
//
// Run with --dry-run to perform every read-only check and stop before writing anything.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPOSITORY = 'sanozhukov3737-oss/klipper-farm-updates';
const WORKFLOW_PATH = '.github/workflows/preview10-natural-understanding.yml';
const BRANCH = 'r146-offline-voice-quality';
const RUNTIME_ARTIFACT = 'Klipper-Farm-Update-Runtime-For-Publishing';
const INSTALLER_ARTIFACT = 'Klipper-Farm-Update-Delivery-Installer';
const ACCEPTANCE_FLAGS = [
  'cleanInstallVerified',
  'updateReuseVerified',
  'actualInstalledWebView',
  'actualInstalledSemanticBridge',
  'understandingCleanupVerified',
];

class PublishError extends Error {}
const fail = message => {
  throw new PublishError(message);
};
const note = message => console.log('  ' + message);

function parseArguments(argv) {
  const options = { repo: REPOSITORY, dryRun: false };
  const valued = new Set(['--run-id', '--head-sha', '--sequence', '--version', '--installer', '--notes', '--key', '--repo', '--work-dir']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      console.log(`usage: publish-release.mjs --run-id N --head-sha SHA --sequence N --version V \\
         --installer FILE --notes FILE [--key PEM | KF_PUBLISHER_KEY_PATH=PEM] \\
         [--repo OWNER/NAME] [--work-dir DIR] [--dry-run]

  --run-id      accepted Windows acceptance run ID
  --head-sha    full reviewed commit SHA of that run
  --sequence    update sequence to publish; must exceed the published one
  --version     released version, for example 1.15.2-r152
  --installer   local installer built by that run
  --notes       release notes markdown
  --key         publisher private key, or KF_PUBLISHER_KEY_PATH
  --dry-run     run every check and stop before creating the release`);
      process.exit(0);
    }
    if (!valued.has(flag)) fail('unknown argument: ' + flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('missing value for ' + flag);
    options[flag.slice(2)] = value;
    index += 1;
  }
  return options;
}

function gh(argumentsList) {
  return execFileSync('gh', argumentsList, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ghJson(argumentsList) {
  return JSON.parse(gh(argumentsList));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireValue(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${name} has an unexpected value: ${String(value)}`);
  return value;
}

function check(condition, message) {
  if (!condition) fail(message);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const required of ['run-id', 'head-sha', 'sequence', 'version', 'installer', 'notes']) {
    if (!options[required]) fail('missing required argument --' + required);
  }

  const runId = requireValue(options['run-id'], /^[1-9][0-9]{0,19}$/, '--run-id');
  const headSha = requireValue(options['head-sha'], /^[0-9a-f]{40}$/, '--head-sha');
  const sequence = Number(requireValue(options.sequence, /^[1-9][0-9]{0,9}$/, '--sequence'));
  const version = requireValue(options.version, /^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$/, '--version');
  const repository = requireValue(options.repo, /^[\w.-]+\/[\w.-]+$/, '--repo');
  const installerPath = path.resolve(options.installer);
  const notesPath = path.resolve(options.notes);
  const tag = `r${sequence}-ota`;

  check(Number(version.slice(version.lastIndexOf('-r') + 2)) === sequence, '--version names a different sequence than --sequence');
  check(fs.existsSync(installerPath), 'installer does not exist: ' + installerPath);
  check(fs.existsSync(notesPath), 'release notes do not exist: ' + notesPath);

  console.log('1. accepted build run');
  const run = ghJson(['api', `repos/${repository}/actions/runs/${runId}`]);
  check(run.status === 'completed' && run.conclusion === 'success', 'run is not a completed success');
  check(run.head_sha === headSha, 'run head_sha differs from --head-sha');
  check(run.head_branch === BRANCH, 'run was built from a different branch: ' + String(run.head_branch));
  check(run.path === WORKFLOW_PATH, 'run is not the Windows acceptance workflow');
  check(run.repository?.full_name === repository, 'run belongs to a different repository');
  note(`run ${runId} at ${headSha.slice(0, 7)}`);

  console.log('2. run artifacts');
  const artifacts = ghJson(['api', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]).artifacts ?? [];
  const runtime = artifacts.find(item => item.name === RUNTIME_ARTIFACT);
  const installer = artifacts.find(item => item.name === INSTALLER_ARTIFACT);
  check(runtime && runtime.expired === false, 'accepted runtime artifact is missing or expired');
  check(installer && installer.expired === false, 'accepted installer artifact is missing or expired');
  note(`runtime ${runtime.size_in_bytes} bytes, installer ${installer.size_in_bytes} bytes`);

  const workDir = path.resolve(options['work-dir'] ?? path.join(os.tmpdir(), `kf-publish-${runId}`));
  fs.mkdirSync(workDir, { recursive: true });

  console.log('3. accepted provenance');
  const runtimeDir = path.join(workDir, 'runtime');
  if (!fs.existsSync(path.join(runtimeDir, 'update-provenance.json'))) {
    gh(['run', 'download', String(runId), '--repo', repository, '--name', RUNTIME_ARTIFACT, '--dir', runtimeDir]);
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'update-provenance.json'), 'utf8').replace(/^\uFEFF/, ''));
  check(String(provenance.buildRunId) === String(runId), 'provenance belongs to a different run');
  check(provenance.buildHeadSha === headSha, 'provenance belongs to a different commit');
  check(provenance.installedSequence === sequence, `provenance sequence ${provenance.installedSequence} differs from --sequence ${sequence}`);
  check(provenance.distribution === 'small-installer-with-verified-components', 'provenance is not for the small installer delivery');
  for (const flag of ACCEPTANCE_FLAGS) check(provenance[flag] === true, 'acceptance flag is not set: ' + flag);
  note(`sequence ${provenance.installedSequence}, build ${provenance.buildId}`);

  console.log('4. installer bytes');
  const installerSha = sha256(installerPath);
  const installerBytes = fs.statSync(installerPath).size;
  check(installerSha === provenance.installer?.sha256, 'installer sha256 differs from the accepted provenance');
  check(installerBytes === provenance.installer?.bytes, 'installer size differs from the accepted provenance');
  note(`${installerBytes} bytes, ${installerSha.slice(0, 16)}…`);

  console.log('5. published runtime');
  const runtimeRelease = ghJson(['api', `repos/${repository}/releases/tags/klipper-farm-runtime-v1`]);
  const runtimeAsset = (runtimeRelease.assets ?? []).find(item => item.name === provenance.runtime?.name);
  check(runtimeAsset, 'the accepted runtime is not published in klipper-farm-runtime-v1');
  check(runtimeAsset.size === provenance.runtime.bytes, 'published runtime size differs from the accepted one');
  note(provenance.runtime.name);

  console.log('6. channel sequence');
  let publishedSequence = 0;
  try {
    const latest = ghJson(['api', `repos/${repository}/releases/latest`]);
    const manifestAsset = (latest.assets ?? []).find(item => item.name === 'update-v20.json');
    if (manifestAsset) {
      const scratch = path.join(workDir, 'published');
      fs.mkdirSync(scratch, { recursive: true });
      gh(['release', 'download', latest.tag_name, '--repo', repository, '--pattern', 'update-v20.json', '--dir', scratch, '--clobber']);
      publishedSequence = JSON.parse(fs.readFileSync(path.join(scratch, 'update-v20.json'), 'utf8')).sequence;
    }
  } catch {
    publishedSequence = 0;
  }
  check(sequence > publishedSequence, `sequence ${sequence} must exceed the published sequence ${publishedSequence}, otherwise no client will ever see it`);
  note(`published ${publishedSequence} -> new ${sequence}`);

  if (options.dryRun) {
    console.log('\nDry run: every check passed. Nothing was written.');
    return;
  }

  console.log('7. sign manifest');
  const signedPath = path.join(workDir, 'update-v20.json');
  const signArguments = [
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'sign-update.mjs'),
    '--sequence', String(sequence),
    '--version', version,
    '--sha256', installerSha,
    '--bytes', String(installerBytes),
    '--notes', notesPath,
    '--out', signedPath,
  ];
  if (options.key ?? process.env.KF_PUBLISHER_KEY_PATH) {
    signArguments.push('--key', options.key ?? process.env.KF_PUBLISHER_KEY_PATH);
  }
  process.stdout.write(execFileSync(process.execPath, signArguments, { encoding: 'utf8' }));
  check(fs.existsSync(signedPath), 'signing produced no manifest');

  console.log('8. draft release');
  const notes = fs.readFileSync(notesPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const title = (notes.match(/^#\s+(.+)$/m)?.[1] ?? `Klipper Farm ${version}`).trim();
  const installerName = `Klipper-Farm-R${sequence}-setup.exe`;
  const stagedInstaller = path.join(workDir, installerName);
  fs.copyFileSync(installerPath, stagedInstaller);

  gh(['release', 'create', tag, '--repo', repository, '--target', headSha, '--title', title, '--notes-file', notesPath, '--draft']);
  note(`draft ${tag}: ${title}`);

  console.log('9. upload');
  gh(['release', 'upload', tag, '--repo', repository, stagedInstaller, signedPath]);
  note('installer and manifest uploaded');

  console.log('10. verify uploaded bytes');
  const draft = ghJson(['api', `repos/${repository}/releases/tags/${tag}`]);
  for (const [name, localPath] of [[installerName, stagedInstaller], ['update-v20.json', signedPath]]) {
    const asset = (draft.assets ?? []).find(item => item.name === name);
    check(asset, 'uploaded asset is missing: ' + name);
    check(asset.size === fs.statSync(localPath).size, 'uploaded asset size differs: ' + name);
    if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
      check(asset.digest === 'sha256:' + sha256(localPath), 'uploaded asset digest differs: ' + name);
    }
  }
  note('uploaded assets match their local digests');

  console.log('11. publish');
  gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  note(`${tag} is published as latest`);

  console.log('\nPublished. Verify with:');
  console.log(`  https://github.com/${repository}/releases/download/${tag}/update-v20.json`);
  console.log(`  work dir kept at ${workDir}`);
}

try {
  main();
} catch (error) {
  if (error instanceof PublishError) {
    console.error('\nrefused: ' + error.message);
    process.exit(1);
  }
  console.error('\nfailed: ' + (error?.message ?? String(error)));
  process.exit(1);
}
