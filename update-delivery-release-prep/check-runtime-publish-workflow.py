"""Exercise the exact runtime publication validator without GitHub writes."""
import ast
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
workflow = yaml.safe_load((ROOT / 'publish-update-runtime.template.yml').read_text())
job = workflow['jobs']['publish-runtime']
assert workflow['permissions'] == {}
assert job['permissions'] == {'actions': 'read', 'contents': 'write'}
assert 'workflow_dispatch' in workflow['on'] and len(workflow['on']) == 1
script = job['steps'][0]['run']
tree = ast.parse(script)
definitions = []
for node in tree.body:
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef)):
        definitions.append(node)
    elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id.isupper():
        definitions.append(node)
namespace = {}
exec(compile(ast.Module(body=definitions, type_ignores=[]), '<runtime-publication-validator>', 'exec'), namespace)
validate = namespace['validate_artifacts']
assert '--clobber' not in [item.value for item in ast.walk(tree) if isinstance(item, ast.Constant) and isinstance(item.value, str)]
assert '--latest=false' in [item.value for item in ast.walk(tree) if isinstance(item, ast.Constant)]

with tempfile.TemporaryDirectory(prefix='kf-runtime-publish-check-') as temporary:
    directory = Path(temporary)
    payload = directory / 'pending.zip'
    with zipfile.ZipFile(payload, 'w') as archive:
        archive.writestr('speech/test.bin', b'test-engine')
        archive.writestr('understanding/runtime/test.exe', b'MZtest-runtime')
    digest = hashlib.sha256(payload.read_bytes()).hexdigest()
    name = 'klipper-farm-runtime-' + digest + '.zip'
    payload = payload.rename(directory / name)
    report = {'schema': 1, 'name': name, 'sha256': digest, 'bytes': payload.stat().st_size,
              'url': namespace['BASE'] + name, 'runtimeFileCount': 2,
              'runtimeUnpackedBytes': len(b'test-engine') + len(b'MZtest-runtime')}
    proof = {'buildRunId': '123', 'buildHeadSha': 'a' * 40,
             'distribution': 'small-installer-with-verified-components',
             'runtime': {key: report[key] for key in ('name', 'sha256', 'bytes', 'url')},
             'installer': {'fileName': 'Klipper-Farm-Update-setup.exe', 'bytes': 32, 'sha256': 'b' * 64},
             **{key: True for key in namespace['ACCEPTANCE_FLAGS']}}
    report_path = directory / 'component-build-report.json'
    proof_path = directory / 'update-provenance.json'
    report_path.write_text(json.dumps(report))
    proof_path.write_text(json.dumps(proof))
    assert validate(directory, '123', 'a' * 40)[0] == payload
    cases = 1

    def rejected():
        global cases
        try:
            validate(directory, '123', 'a' * 40)
        except (ValueError, OSError):
            cases += 1
        else:
            raise AssertionError('Invalid publication evidence was accepted')

    for field, bad in [('buildRunId', '999'), ('buildHeadSha', 'c' * 40),
                       ('updateReuseVerified', False), ('actualInstalledWebView', None)]:
        changed = dict(proof, **{field: bad})
        proof_path.write_text(json.dumps(changed))
        rejected()
    proof_path.write_text(json.dumps(proof))
    extra = directory / 'model.gguf'
    extra.write_bytes(b'never-publish-model')
    rejected()
    extra.unlink()
    changed = dict(report, bytes=report['bytes'] + 1)
    report_path.write_text(json.dumps(changed))
    rejected()
    report_path.write_text(json.dumps(report))
    original = payload.read_bytes()
    payload.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    rejected()
    payload.write_bytes(original)
    proof['installer']['bytes'] = 512 * 1024 ** 2 + 1
    proof_path.write_text(json.dumps(proof))
    rejected()
    proof['installer']['bytes'] = 32
    for unsafe in ('speech/../outside.bin', 'speech/CON.txt', 'understanding/model.gguf'):
        payload.unlink()
        temporary_zip = directory / 'pending.zip'
        with zipfile.ZipFile(temporary_zip, 'w') as archive:
            archive.writestr(unsafe, b'invalid')
        digest = hashlib.sha256(temporary_zip.read_bytes()).hexdigest()
        name = 'klipper-farm-runtime-' + digest + '.zip'
        payload = temporary_zip.rename(directory / name)
        report.update(name=name, sha256=digest, bytes=payload.stat().st_size,
                      url=namespace['BASE'] + name, runtimeFileCount=1, runtimeUnpackedBytes=7)
        proof['runtime'] = {key: report[key] for key in ('name', 'sha256', 'bytes', 'url')}
        report_path.write_text(json.dumps(report))
        proof_path.write_text(json.dumps(proof))
        rejected()
print(f'Runtime publication YAML and exact validator checks passed: {cases} cases; no remote writes.')
