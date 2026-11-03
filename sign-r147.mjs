import fs from 'node:fs';
import crypto from 'node:crypto';

const notes = fs.readFileSync('r147-release-notes.md', 'utf8').replace(/\n$/, '');
const pubRaw = Buffer.from('28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'hex');
const signerKeyId = crypto.createHash('sha256').update(pubRaw).digest('hex').slice(0, 32);
const unsigned = {
  schemaVersion: 1,
  channel: 'stable',
  sequence: 147,
  version: '1.14.7-r147',
  publishedAt: Date.now(),
  artifact: {
    url: 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/download/r147-ota/Klipper-Farm-R147-setup.exe',
    sha256: 'd236ea2ef06c595956e7cdbb2293ae56dc2e0307c211b741631abcbec61e0d68',
    sizeBytes: 285321458,
  },
  releaseNotes: notes,
  signerKeyId,
};
const key = crypto.createPrivateKey(fs.readFileSync('../KF-PUBLISHER-PRIVATE.pem'));
const msg = Buffer.concat([Buffer.from('klipper-farm-update-manifest-v1\0'), Buffer.from(JSON.stringify(unsigned))]);
const signatureHex = crypto.sign(null, msg, key).toString('hex');
const manifest = { ...unsigned, signatureHex };
fs.writeFileSync('r147-signed-update.json', JSON.stringify(manifest, null, 2) + '\n');
const vkey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]), format: 'der', type: 'spki' });
const ok = crypto.verify(null, msg, vkey, Buffer.from(signatureHex, 'hex'));
console.log('signature valid:', ok);
console.log('signerKeyId:', signerKeyId);
