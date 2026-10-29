"""Bundle the app-local Microsoft CRT required by the unmodified speech executables."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys

if sys.platform != 'win32':
    raise SystemExit('Prepare Microsoft runtime on the Windows build host')
app = Path(sys.argv[1]).resolve()
speech = app / 'src-tauri' / 'speech'
vswhere = Path(os.environ['ProgramFiles(x86)']) / 'Microsoft Visual Studio' / 'Installer' / 'vswhere.exe'
vs = Path(subprocess.check_output([str(vswhere), '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], text=True).strip())
versions = [path for path in (vs / 'VC' / 'Redist' / 'MSVC').iterdir() if path.is_dir() and path.name[:1].isdigit()]
version = max(versions, key=lambda path: tuple(map(int, path.name.split('.'))))
crt = list((version / 'x64').glob('Microsoft.VC*.CRT'))
openmp = list((version / 'x64').glob('Microsoft.VC*.OpenMP'))
if len(crt) != 1 or len(openmp) != 1:
    raise SystemExit('Could not resolve the x64 app-local CRT and OpenMP redistributables')
for engine in ('silero/python', 'whisper'):
    for source in sorted(crt[0].glob('*.dll')):
        shutil.copyfile(source, speech / engine / source.name)
for source in sorted(openmp[0].glob('*.dll')):
    shutil.copyfile(source, speech / 'whisper' / source.name)
for engine in ('silero/python', 'whisper'):
    for name in ('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        if not (speech / engine / name).is_file():
            raise SystemExit(f'Missing {engine}/{name}')
if not (speech / 'whisper' / 'vcomp140.dll').is_file():
    raise SystemExit('Missing Whisper OpenMP runtime')

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

manifest = [{'path': path.relative_to(speech).as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path)}
            for path in sorted(speech.rglob('*')) if path.is_file() and path.name != 'manifest.json']
(speech / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Bundled x64 Microsoft runtime {version.name}; speech resource manifest: {len(manifest)} files')
