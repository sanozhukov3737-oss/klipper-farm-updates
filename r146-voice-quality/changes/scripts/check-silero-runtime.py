"""Run the packaged Windows Python and selected voice before the native build."""
import array
import json
import math
from pathlib import Path
import subprocess
import sys
import time

if sys.platform != 'win32':
    raise SystemExit('The embedded Windows runtime must be tested on Windows')
app = Path(__file__).resolve().parent.parent
root = app / 'src-tauri/speech/silero'
command = [str(root / 'python/python.exe'), '-I', '-X', 'utf8', 'tts.py']
# Verify the numeric text sent to the model, as well as the resulting real audio.
normalization = subprocess.run([str(root / 'python/python.exe'), '-I', '-X', 'utf8', '-c', "import runpy;w=runpy.run_path('tts.py');print(w['spoken_text']('Осталось 23 минуты. Сопло 250°C. Запас 1.500 кг. Время 20:34.'))"], cwd=root, capture_output=True, timeout=10)
assert normalization.returncode == 0
normalized = normalization.stdout.decode('utf-8')
assert all(value in normalized for value in ['двадцать три минуты', 'двести пятьдесят градусов Цельсия', 'одна целая пять десятых килограмма', 'двадцать часов тридцать четыре минуты']), normalized
before = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
started = time.monotonic()
result = subprocess.run(command, cwd=root, input='Привет! Рада тебя слышать. Принтер K1 Max готов к работе. Осталось 23 минуты.\n'.encode('utf-8'), capture_output=True, timeout=40)
if result.returncode:
    raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
pcm = array.array('h', result.stdout)
if sys.byteorder != 'little':
    pcm.byteswap()
rms = math.sqrt(sum((x / 32768) ** 2 for x in pcm) / len(pcm))
assert len(result.stdout) % 2 == 0 and 2 * 48000 < len(pcm) < 30 * 48000
assert rms > 0.005
invalid = subprocess.run(command, cwd=root, input=b'bad\x00input', capture_output=True, timeout=10)
assert invalid.returncode != 0 and not invalid.stdout
after = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
assert before == after, 'Speech synthesis must not create files in the installation'
report = {'passed': True, 'platform': sys.platform, 'voiceId': 'kseniya', 'model': 'Silero v5_6_ru', 'packagedPython': True, 'systemPythonUsedForSynthesis': False, 'sampleRate': 48000, 'pcmBytes': len(result.stdout), 'audioSeconds': len(pcm) / 48000, 'rms': rms, 'elapsedSeconds': round(time.monotonic() - started, 2), 'numericSpeechVerified': True, 'invalidInputRejected': True, 'runtimeDirectoryUnchanged': True, 'physicalPrintersTested': False}
(app / 'silero-runtime-proof.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
