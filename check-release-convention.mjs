#!/usr/bin/env node
// Verify that every published release manifest agrees with a notes file in this repository.
//
// The signed manifest carries the release notes verbatim, and that text is what users see
// in the update dialog. Editing a notes file after signing, or renaming it so the pair is
// lost, silently desynchronises the two. The sequence-152 release made that concrete: the
// published notes lived in r155-release-notes.md while the release itself was tagged
// r152-ota, so nothing tied the file to the tag.
//
// This check is offline. It reads only checked-in files.

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);

const normalise = text => text.replace(/\r\n/g, '\n').replace(/\n$/, '');

const manifests = fs
  .readdirSync(root)
  .filter(name => /^r[0-9]+-signed-update\.json$/.test(name))
  .map(name => ({ name, sequence: Number(name.slice(1, name.indexOf('-signed-update'))) }))
  .sort((left, right) => left.sequence - right.sequence);

if (manifests.length === 0) {
  console.error('no signed update manifests found');
  process.exit(1);
}

// The tag convention r<N>-ota and notes that stay identical to the signed text both begin
// at this sequence. Earlier releases used plain r<N> tags and their notes files were edited
// afterwards, so they are reported as history instead of failing the gate.
const CONVENTION_FROM = 145;

const failures = [];
const notes = [];
const sequences = new Map();

for (const entry of manifests) {
  const legacyEntry = entry.sequence < CONVENTION_FROM;
  const manifestPath = path.join(root, entry.name);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    failures.push(`${entry.name}: not valid JSON (${error.message})`);
    continue;
  }

  if (manifest.sequence !== entry.sequence) {
    failures.push(`${entry.name}: file name says ${entry.sequence} but the manifest says ${manifest.sequence}`);
  }

  if (sequences.has(manifest.sequence)) {
    failures.push(`${entry.name}: sequence ${manifest.sequence} is also used by ${sequences.get(manifest.sequence)}`);
  } else {
    sequences.set(manifest.sequence, entry.name);
  }

  const suffix = new RegExp(`-r${manifest.sequence}$`);
  if (typeof manifest.version !== 'string' || !suffix.test(manifest.version)) {
    failures.push(`${entry.name}: version ${manifest.version} does not name sequence ${manifest.sequence}`);
  }

  // The tag in the artifact URL must match the sequence, otherwise the manifest points at
  // another release's asset.
  const tag = `releases/download/r${manifest.sequence}-ota/`;
  const tagMatches = typeof manifest.artifact?.url === 'string' && manifest.artifact.url.includes(tag);
  if (!tagMatches && !legacyEntry) {
    failures.push(`${entry.name}: artifact URL does not point at r${manifest.sequence}-ota`);
  }

  // Convention since sequence 145: <tag>-release-notes.md. Earlier releases used
  // r<N>-release-notes.md, which is still accepted so history stays checkable.
  const candidates = [`r${manifest.sequence}-ota-release-notes.md`, `r${manifest.sequence}-release-notes.md`];
  const found = candidates.find(name => fs.existsSync(path.join(root, name)));
  if (!found) {
    if (legacyEntry) {
      notes.push({ sequence: manifest.sequence, file: entry.name, note: 'history: no notes file was ever committed' });
      continue;
    }
    failures.push(`${entry.name}: no notes file among ${candidates.join(' or ')}`);
    continue;
  }

  const fileNotes = normalise(fs.readFileSync(path.join(root, found), 'utf8'));
  if (fileNotes !== manifest.releaseNotes) {
    if (legacyEntry) {
      notes.push({ sequence: manifest.sequence, file: found, note: 'history: notes were edited after signing' });
      continue;
    }
    failures.push(`${entry.name}: notes in ${found} differ from the signed releaseNotes`);
    continue;
  }

  notes.push({ sequence: manifest.sequence, file: found, note: found === candidates[0] || legacyEntry ? '' : 'legacy file name' });
}

// Sequences must increase by exactly one across published releases: a gap means a release
// was published without a manifest here, and a repeat is rejected by the updater.
for (let index = 1; index < manifests.length; index += 1) {
  const previous = manifests[index - 1].sequence;
  const current = manifests[index].sequence;
  if (current !== previous + 1) {
    failures.push(`sequence jumps from ${previous} to ${current}; expected ${previous + 1}`);
  }
}

if (failures.length) {
  console.error('release convention failed:');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}

const history = notes.filter(item => item.note);
console.log(`release convention OK: ${notes.length} published manifests, sequences ${manifests[0].sequence}..${manifests.at(-1).sequence}`);
console.log(`  enforced from sequence ${CONVENTION_FROM}`);
for (const item of history) console.log(`  ${item.sequence}: ${item.file} — ${item.note}`);
