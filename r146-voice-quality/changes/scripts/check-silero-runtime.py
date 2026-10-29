"""Exercise the packaged Windows voice in both source and Unicode paths."""
import array
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if sys.platform != 'win32':
    raise SystemExit('The embedded Windows runtime must be tested on Windows')
app = Path(__file__).resolve().parent.parent
root = app / 'src-tauri/speech/silero'


def check_runtime(runtime, label):
    command = [str(runtime / 'python/python.exe'), '-I', '-X', 'utf8', 'tts.py']
    normalization = subprocess.run([
        *command[:-1], '-c',
        "import runpy;w=runpy.run_path('tts.py');print(w['spoken_text']('Осталось 23 минуты. Сопло 250°C. Запас 1.500 кг. Время 20:34.'))",
    ], cwd=runtime, capture_output=True, timeout=10)
    if normalization.returncode:
        raise RuntimeError(f'{label}: ' + normalization.stderr.decode('utf-8', errors='replace'))
    normalized = normalization.stdout.decode('utf-8')
    assert all(value in normalized for value in [
        'двадцать три минуты', 'двести пятьдесят градусов Цельсия',
        'одна целая пять десятых килограмма', 'двадцать часов тридцать четыре минуты',
    ]), normalized
    before = {p.relative_to(runtime).as_posix() for p in runtime.rglob('*') if p.is_file()}
    started = time.monotonic()
    result = subprocess.run(command, cwd=runtime, input=(
        'Привет! Рада тебя слышать. Принтер K1 Max готов к работе. Осталось 23 минуты.\n'
    ).encode('utf-8'), capture_output=True, timeout=40)
    if result.returncode:
        raise RuntimeError(f'{label}: ' + result.stderr.decode('utf-8', errors='replace'))
    pcm = array.array('h', result.stdout)
    if sys.byteorder != 'little':
        pcm.byteswap()
    assert len(result.stdout) % 2 == 0 and 2 * 48000 < len(pcm) < 30 * 48000
    rms = math.sqrt(sum((x / 32768) ** 2 for x in pcm) / len(pcm))
    assert rms > 0.005
    invalid = subprocess.run(command, cwd=runtime, input=b'bad\x00input', capture_output=True, timeout=10)
    assert invalid.returncode != 0 and not invalid.stdout
    after = {p.relative_to(runtime).as_posix() for p in runtime.rglob('*') if p.is_file()}
    assert before == after, 'Speech synthesis must not create files in the installation'
    return {
        'case': label, 'sampleRate': 48000, 'pcmBytes': len(result.stdout),
        'audioSeconds': len(pcm) / 48000, 'rms': rms,
        'elapsedSeconds': round(time.monotonic() - started, 2),
        'numericSpeechVerified': True, 'invalidInputRejected': True,
        'runtimeDirectoryUnchanged': True,
    }


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)
    return destination


cases = [check_runtime(root, 'build-directory')]
with tempfile.TemporaryDirectory(prefix='Ксения проверка голоса ') as temporary:
    unicode_root = Path(temporary) / 'Речевой модуль'
    shutil.copytree(root, unicode_root, copy_function=link_or_copy)
    cases.append(check_runtime(unicode_root, 'cyrillic-and-spaces'))
    # Preserve the exact old reader's result as diagnostic evidence. It may
    # succeed on systems whose C runtime already uses UTF-8, so it is not a gate.
    legacy = subprocess.run([
        str(unicode_root / 'python/python.exe'), '-I', '-X', 'utf8', '-c',
        "from pathlib import Path;import torch;torch.package.PackageImporter(str(Path('v5_6_ru.pt').resolve()))",
    ], cwd=unicode_root, capture_output=True, timeout=30)
    filename_reader = {
        'exitCode': legacy.returncode,
        'stderrTail': legacy.stderr.decode('utf-8', errors='replace')[-4000:],
    }

report = {
    'passed': True, 'platform': sys.platform, 'voiceId': 'kseniya', 'model': 'Silero v5_6_ru',
    'packagedPython': True, 'systemPythonUsedForSynthesis': False,
    **{key: value for key, value in cases[0].items() if key != 'case'},
    'unicodePathVerified': True, 'cases': cases, 'filenameReaderProbe': filename_reader,
    'physicalPrintersTested': False,
}
(app / 'silero-runtime-proof.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
