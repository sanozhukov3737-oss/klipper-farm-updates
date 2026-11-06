#!/usr/bin/env node
// Sign a Klipper Farm update manifest (update-v20.json).
//
// Replaces the one-off sign-rNNN.mjs scripts, which hardcoded the sequence, version,
// artifact hash, size and output name, so every release needed a newly written script.
// Here everything about the artifact is an argument and the publisher key is never
// baked into the repository: it is read from --key or KF_PUBLISHER_KEY_PATH.
//
// The public half of the key is not hardcoded either. It is taken from the packaged
// updater channel (UPDATE-CHANNEL.json) that the manifest will be served against, so a
// manifest can never be signed with a key that installed clients do not trust.
//
// No network access. No publication. The signature is verified before anything is written.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_DOMAIN = 'klipper-farm-update-manifest-v1\0';
const CHANNEL_FILENAME = 'UPDATE-CHANNEL.json';

function fail(message) {
  console.error('error: ' + message);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { channel: null, key: process.env.KF_PUBLISHER_KEY_PATH ?? null };
  const valued = new Set(['--sequence', '--version', '--sha256', '--bytes', '--notes', '--out', '--artifact-name', '--channel', '--key']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      console.log(`usage: sign-update.mjs --sequence N --version V --sha256 HEX --bytes N --notes FILE [--out FILE]
                        [--artifact-name NAME] [--channel UPDATE-CHANNEL.json]
                        [--key PEM | KF_PUBLISHER_KEY_PATH=PEM]

  --sequence       update sequence, must be a positive integer
  --version        released version, for example 1.15.2-r152
  --sha256         sha256 of the installer, 64 lowercase hex characters
  --bytes          size of the installer in bytes
  --notes          release notes markdown file; CRLF is normalised to LF
  --out            signed manifest path (default: update-v20.json)
  --artifact-name  installer asset file name (default: Klipper-Farm-R<sequence>-setup.exe)
  --channel        packaged updater channel that carries the trusted public key
  --key            publisher private key; never printed and never committed`);
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

function findChannel(explicit) {
  const candidates = explicit
    ? [explicit]
    : [
        path.join('work', 'app', CHANNEL_FILENAME),
        path.join('..', CHANNEL_FILENAME),
        CHANNEL_FILENAME,
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  fail('packaged updater channel not found; pass --channel <path to ' + CHANNEL_FILENAME + '>');
}

function readHexPublicKey(channelPath) {
  const channel = JSON.parse(fs.readFileSync(channelPath, 'utf8').replace(/^\uFEFF/, ''));
  const hex = channel.publicKeyHex;
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
    fail('channel publicKeyHex is not a 32-byte lowercase hex value: ' + channelPath);
  }
  if (channel.channel !== 'stable' && channel.channel !== 'beta') {
    fail('channel is neither stable nor beta: ' + String(channel.channel));
  }
  return { channel, publicRaw: Buffer.from(hex, 'hex') };
}

function readNotes(notesPath) {
  const text = fs.readFileSync(notesPath, 'utf8');
  const normalised = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (normalised.trim().length === 0) fail('release notes are empty: ' + notesPath);
  return normalised;
}

function requirePattern(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${name} has an unexpected format: ${String(value)}`);
  return value;
}

const options = parseArguments(process.argv.slice(2));

for (const required of ['sequence', 'version', 'sha256', 'bytes', 'notes']) {
  if (!options[required]) fail('missing required argument --' + required);
}

const sequence = Number(requirePattern(options.sequence, /^[1-9][0-9]{0,9}$/, '--sequence'));
const version = requirePattern(options.version, /^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$/, '--version');
const artifactSha256 = requirePattern(options.sha256, /^[0-9a-f]{64}$/, '--sha256');
const artifactBytes = Number(requirePattern(options.bytes, /^[1-9][0-9]{0,11}$/, '--bytes'));

// A version that names a different sequence than the manifest is a real defect: the
// updater shows the version string to the user and compares the sequence internally.
const versionSequence = Number(version.slice(version.lastIndexOf('-r') + 2));
if (versionSequence !== sequence) {
  fail(`--version names sequence ${versionSequence} but --sequence is ${sequence}`);
}

if (!options.key) fail('publisher key is required; pass --key <pem> or set KF_PUBLISHER_KEY_PATH');
const keyPath = path.resolve(options.key);
if (!fs.existsSync(keyPath)) fail('publisher key does not exist: ' + keyPath);

const channelPath = findChannel(options.channel);
const { channel, publicRaw } = readHexPublicKey(channelPath);
const signerKeyId = crypto.createHash('sha256').update(publicRaw).digest('hex').slice(0, 32);

const artifactName = options['artifact-name'] ?? `Klipper-Farm-R${sequence}-setup.exe`;
if (!/^[^\\/:*?"<>|]+-setup\.exe$/.test(artifactName)) fail('artifact name is not a plain setup executable: ' + artifactName);

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
if (privateKey.asymmetricKeyType !== 'ed25519') {
  fail('publisher key must be an ed25519 key, got ' + String(privateKey.asymmetricKeyType));
}

// Refuse to sign with a key that installed clients do not trust. This is the whole
// point of reading the public half from the packaged channel instead of a constant.
const derivedPublic = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
if (!derivedPublic.equals(publicRaw)) {
  fail('publisher key does not match the channel publicKeyHex in ' + channelPath);
}

const unsigned = {
  schemaVersion: 1,
  channel: 'stable',
  sequence,
  version,
  publishedAt: Date.now(),
  artifact: {
    url: `https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/download/r${sequence}-ota/${artifactName}`,
    sha256: artifactSha256,
    sizeBytes: artifactBytes,
  },
  releaseNotes: readNotes(path.resolve(options.notes)),
  signerKeyId,
};

const message = Buffer.concat([Buffer.from(MANIFEST_DOMAIN, 'utf8'), Buffer.from(JSON.stringify(unsigned), 'utf8')]);
const signatureHex = crypto.sign(null, message, privateKey).toString('hex');
const manifest = { ...unsigned, signatureHex };

// Verify exactly the way the production updater does, including the key identifier,
// so a mis-signed manifest can never be written out.
const verificationKey = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicRaw]),
  format: 'der',
  type: 'spki',
});
if (!crypto.verify(null, message, verificationKey, Buffer.from(signatureHex, 'hex'))) {
  fail('signature does not verify against the channel public key');
}

const outPath = path.resolve(options.out ?? 'update-v20.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8' });

console.log('signed manifest: ' + outPath);
console.log('  sequence: ' + sequence);
console.log('  version: ' + version);
console.log('  artifact: ' + artifactName + ' (' + artifactBytes + ' bytes)');
console.log('  signerKeyId: ' + signerKeyId);
console.log('  signature: verified against ' + channelPath);
