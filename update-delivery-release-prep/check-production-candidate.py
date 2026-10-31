"""Focused tests; only public signature fixtures, no signing keys or network.

Usage: python check-production-candidate.py --source FIX4.zip --workflow FIX4.yml
Successful run/provenance inputs below are synthetic unit fixtures, not actual
Windows acceptance. The real preparer refuses the currently running CI job.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

DIRECTORY = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('production_candidate', DIRECTORY / 'prepare-production-candidate.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
SOURCE = WORKFLOW = None
FIXTURE_SHA = '631533701d2e61a698b4cc5696201209982eaf1a0c7c6c79d1528707903b2654'


def run_fixture():
    return {'id': builder.RUN_ID, 'head_sha': builder.COMMIT, 'head_branch': builder.BRANCH,
            'path': builder.WORKFLOW_PATH, 'name': builder.WORKFLOW_NAME,
            'repository': {'full_name': builder.REPO}, 'status': 'completed', 'conclusion': 'success'}


def proof_fixture():
    sha = 'a' * 64
    name = 'klipper-farm-runtime-' + sha + '.zip'
    return {'buildRunId': str(builder.RUN_ID), 'buildHeadSha': builder.COMMIT,
            'buildId': builder.FIX4_BUILD, 'installedSequence': 144, 'preview': True,
            'stablePublished': False, 'runtimePublished': False, 'standaloneInstaller': True,
            'requiredComponentsFetchedWhenMissing': True,
            'distribution': 'small-installer-with-verified-components',
            **{flag: True for flag in builder.FLAGS},
            'installer': {'fileName': 'Klipper-Farm-Update-Delivery-setup.exe', 'bytes': 32, 'sha256': 'b' * 64},
            'runtime': {'name': name, 'sha256': sha, 'bytes': 64,
                        'url': f'https://github.com/{builder.REPO}/releases/download/klipper-farm-runtime-v1/{name}'},
            'model': {'bytes': 2497281120,
                      'sha256': '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597'}}


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='kf-production-prep-test-')
        self.root = Path(self.directory.name)
        self.stable_bytes = (DIRECTORY / 'public-stable-r144-fixture.json').read_bytes()
        self.assertEqual(hashlib.sha256(self.stable_bytes).hexdigest(), FIXTURE_SHA)
        self.stable = builder.parse_json(self.stable_bytes)
        self.run = run_fixture()
        self.proof = proof_fixture()
        self.inputs = [self.root / name for name in ('source.zip', 'workflow.yml', 'run.json', 'proof.json', 'stable.json')]
        self.inputs[0].write_bytes(SOURCE.read_bytes())
        self.inputs[1].write_bytes(WORKFLOW.read_bytes())
        self.output = self.root / 'candidate'
        self.write_evidence()

    def tearDown(self):
        self.directory.cleanup()

    def write_evidence(self):
        for path, value in zip(self.inputs[2:], (self.run, self.proof, self.stable)):
            path.write_text(json.dumps(value), encoding='utf-8')

    def prepare(self):
        return builder.prepare(*self.inputs, self.output)

    def rejected_without_output(self):
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_real_existing_key_signature_and_tamper_rejection(self):
        builder.verify_stable(self.stable)
        for field, value in [('releaseNotes', 'tampered public notes'), ('signatureHex', '00' * 64),
                             ('sequence', 145), ('signerKeyId', '00' * 16)]:
            with self.subTest(field=field):
                changed = dict(self.stable, **{field: value})
                with self.assertRaises(ValueError):
                    builder.verify_stable(changed)

    def test_running_queued_failed_jobs_fail_before_any_crypto_or_output(self):
        for status, conclusion in [('in_progress', None), ('queued', None), ('completed', 'failure'),
                                    ('completed', 'cancelled'), ('completed', 'timed_out')]:
            self.run.update(status=status, conclusion=conclusion)
            self.write_evidence()
            with patch.object(builder, 'verify_stable', side_effect=AssertionError('Authentication must not run yet')):
                self.rejected_without_output()

    def test_wrong_commit_branch_run_and_workflow_rejected(self):
        for field, value in [('id', builder.RUN_ID + 1), ('head_sha', '0' * 40),
                             ('head_branch', 'main'), ('path', '.github/workflows/release.yml'),
                             ('name', 'other workflow')]:
            with self.subTest(field=field):
                self.run = dict(run_fixture(), **{field: value})
                self.write_evidence()
                self.rejected_without_output()

    def test_missing_flags_or_unpinned_artifacts_rejected(self):
        mutations = [(flag, False) for flag in builder.FLAGS]
        mutations += [('buildHeadSha', '0' * 40), ('installedSequence', 145),
                      ('stablePublished', True), ('runtimePublished', True)]
        for field, value in mutations:
            with self.subTest(field=field):
                self.proof = dict(proof_fixture(), **{field: value})
                self.write_evidence()
                self.rejected_without_output()
        for field, subfield, value in [('installer', 'bytes', 512 * 1024 ** 2 + 1),
                                       ('runtime', 'url', 'https://example.com/engine.zip'),
                                       ('runtime', 'sha256', 'A' * 64), ('model', 'bytes', 0)]:
            with self.subTest(field=field, subfield=subfield):
                self.proof = proof_fixture()
                self.proof[field][subfield] = value
                self.write_evidence()
                self.rejected_without_output()

    def test_source_workflow_and_authenticated_stable_must_match(self):
        for index in (0, 1):
            original = self.inputs[index].read_bytes()
            self.inputs[index].write_bytes(original + b'\n')
            self.rejected_without_output()
            self.inputs[index].write_bytes(original)
        self.stable['releaseNotes'] = 'tampered'
        self.write_evidence()
        self.rejected_without_output()

    def test_no_overwrite_and_no_symlink_inputs(self):
        self.output.mkdir()
        sentinel = self.output / 'untouched'
        sentinel.write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError, 'refusing overwrite'):
            self.prepare()
        self.assertEqual(sentinel.read_bytes(), b'keep')
        sentinel.unlink()
        self.output.rmdir()
        real_source = self.inputs[0].rename(self.root / 'real-source.zip')
        self.inputs[0].symlink_to(real_source)
        self.rejected_without_output()

    def test_positive_local_candidate_changes_only_identity_and_channel(self):
        original_hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in self.inputs]
        report = self.prepare()
        self.assertTrue(report['localDraftOnly'])
        self.assertFalse(report['stablePublished'])
        self.assertFalse(report['runtimePublished'])
        self.assertFalse(report['ciDispatched'])
        self.assertEqual(report['installedSequence'], 145)
        self.assertEqual(original_hashes, [hashlib.sha256(path.read_bytes()).hexdigest() for path in self.inputs])
        candidate_source = (self.output / 'preview10-understanding-source.zip').read_bytes()
        candidate_workflow = (self.output / 'preview10-natural-understanding.yml').read_text()
        self.assertIn(hashlib.sha256(candidate_source).hexdigest(), candidate_workflow)
        self.assertNotIn(builder.SOURCE_SHA, candidate_workflow)
        self.assertIn('installedSequence=$candidateChannel.installedSequence', candidate_workflow)
        self.assertIn('$candidateProof.installedSequence -ne $candidateChannel.installedSequence', candidate_workflow)
        self.assertIn('$candidateChannel.installedSequence -ne 145', candidate_workflow)
        self.assertNotIn('gh release upload', candidate_workflow)
        with zipfile.ZipFile(self.inputs[0]) as before, zipfile.ZipFile(io.BytesIO(candidate_source)) as after:
            changed = {name for name in after.namelist() if name not in before.namelist() or after.read(name) != before.read(name)}
            self.assertEqual(changed, {builder.PREFIX + name for name in
                ('changes/UPDATE-CHANNEL.json', 'changes/RELEASE-BUILD-ID.txt', 'apply.py', 'source-manifest.json',
                 'changes/scripts/check-r9-clean-installer.mjs', 'changes/scripts/check-release-portability.mjs')})
            original = builder.parse_json(before.read(builder.PREFIX + 'source-manifest.json'))
            manifest = builder.parse_json(after.read(builder.PREFIX + 'source-manifest.json'))
            before_guards = {row['path']: row['beforeSha256'] for row in original['files']}
            after_guards = {row['path']: row['beforeSha256'] for row in manifest['files']}
            self.assertEqual(before_guards, {key: after_guards[key] for key in before_guards})
            self.assertEqual(after_guards['UPDATE-CHANNEL.json'], builder.CHANNEL_BEFORE_SHA)
            self.assertEqual(len(after_guards), len(manifest['files']))
            self.assertEqual(len(manifest['files']), 57)
            for name in after.namelist():
                self.assertNotIn(builder.FIX4_BUILD.encode(), after.read(name), name)
            self.assertIn(b'channel.installedSequence,145', after.read(builder.PREFIX + 'changes/scripts/check-r9-clean-installer.mjs'))
            self.assertIn(b'updateChannel.installedSequence,145', after.read(builder.PREFIX + 'changes/scripts/check-release-portability.mjs'))
            channel = builder.parse_json(after.read(builder.PREFIX + 'changes/UPDATE-CHANNEL.json'))
            self.assertEqual(channel, dict(builder.CHANNEL, installedSequence=145))
            self.exercise_actual_apply(after)

    def exercise_actual_apply(self, archive):
        # The real archived apply code is tested on a small disposable hash-bound
        # fixture. Full original 56-file binding remains covered by pinned ZIP and
        # unchanged before-hash checks above; no external app checkout is needed.
        overlay = self.root / 'overlay'
        overlay.mkdir()
        apply_path = overlay / 'apply.py'
        apply_path.write_bytes(archive.read(builder.PREFIX + 'apply.py'))
        identity = 'V20.6-R14.5-OFFLINE-VOICE-PREVIEW9-2026-10-30'
        data_before, data_after = b'original\n', b'changed\n'
        values = [('UPDATE-CHANNEL.json', builder.CHANNEL_BYTES,
                   archive.read(builder.PREFIX + 'changes/UPDATE-CHANNEL.json')),
                  ('RELEASE-BUILD-ID.txt', (identity + '\n').encode(), (builder.PRODUCTION_BUILD + '\n').encode()),
                  ('safe.txt', data_before, data_after)]
        manifest = {'beforeBuildId': identity, 'buildId': builder.PRODUCTION_BUILD, 'files': []}
        for name, before, after in values:
            target = overlay / 'changes' / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(after)
            manifest['files'].append({'path': name, 'beforeSha256': builder.digest(before),
                                      'sha256': builder.digest(after), 'bytes': len(after)})
        (overlay / 'source-manifest.json').write_text(json.dumps(manifest))
        for use_crlf in (False, True):
            fixture = self.root / ('base-crlf' if use_crlf else 'base-lf')
            fixture.mkdir()
            for name, before, _ in values:
                (fixture / name).write_bytes(before.replace(b'\n', b'\r\n') if use_crlf else before)
            result = subprocess.run([sys.executable, str(apply_path), str(fixture)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name, _, after in values:
                self.assertEqual((fixture / name).read_bytes(), after)
            result = subprocess.run([sys.executable, str(apply_path), str(fixture)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        fixture = self.root / 'tampered'
        fixture.mkdir()
        for name, before, _ in values:
            (fixture / name).write_bytes(before)
        (fixture / 'safe.txt').write_bytes(b'tampered')
        snapshot = {name: (fixture / name).read_bytes() for name, _, _ in values}
        result = subprocess.run([sys.executable, str(apply_path), str(fixture)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(snapshot, {name: (fixture / name).read_bytes() for name, _, _ in values})
        # Even a sequence-144 base with a changed endpoint/key/channel is not an
        # eligible source: the update trust configuration must remain exact.
        for field, wrong in [('endpoint', 'https://example.com/update.json'),
                             ('publicKeyHex', '00' * 32), ('channel', 'beta')]:
            wrong_fixture = self.root / ('wrong-' + field)
            wrong_fixture.mkdir()
            for name, before, _ in values:
                (wrong_fixture / name).write_bytes(before)
            wrong_channel = dict(builder.CHANNEL, **{field: wrong})
            (wrong_fixture / 'UPDATE-CHANNEL.json').write_text(json.dumps(wrong_channel))
            snapshot = {name: (wrong_fixture / name).read_bytes() for name, _, _ in values}
            result = subprocess.run([sys.executable, str(apply_path), str(wrong_fixture)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(snapshot, {name: (wrong_fixture / name).read_bytes() for name, _, _ in values})

    def test_duplicate_json_fields_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            builder.parse_json(b'{"sequence":144,"sequence":145}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--workflow', type=Path, required=True)
    args, remaining = parser.parse_known_args()
    SOURCE, WORKFLOW = args.source, args.workflow
    unittest.main(argv=[sys.argv[0], *remaining])
