"""Verify the pinned speech executables on Windows without the desktop test harness."""
from pathlib import Path
import array
import io
import json
import math
import subprocess
import sys
import time
import wave

assert sys.platform == 'win32'
speech = Path('r146-voice-quality/changes/src-tauri/speech').resolve()
samples = []
raw = None
for voice in ('denis', 'dmitri'):
    started = time.monotonic()
    result = subprocess.run([str(speech / 'piper/piper.exe'), '--model', f'ru_RU-{voice}-medium.onnx', '--espeak_data', 'espeak-ng-data', '--output-raw'],
                            cwd=speech / 'piper', input='Принтер кей один макс, поставь на печать корпус.\n'.encode(), capture_output=True, timeout=40)
    if result.returncode:
        raise SystemExit(f'Piper {voice} failed: {result.returncode}; {result.stderr.decode("utf-8",errors="replace")}')
    pcm = array.array('h')
    pcm.frombytes(result.stdout)
    rms = math.sqrt(sum((value / 32768) ** 2 for value in pcm) / len(pcm))
    assert len(pcm) > 22050 and rms > 0.001
    samples.append({'voice': voice, 'pcmBytes': len(result.stdout), 'rms': rms, 'seconds': round(time.monotonic() - started, 2)})
    raw = pcm

resampled = array.array('h', (raw[int(i * 22050 / 16000)] for i in range(int(len(raw) * 16000 / 22050))))
audio = io.BytesIO()
with wave.open(audio, 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(16000)
    output.writeframes(resampled.tobytes())
variants=[]
args_file=speech/'whisper/recognition.args'
assert b'\r' not in args_file.read_bytes()
assert 'корпус' in args_file.read_text(encoding='utf-8')
for mode in ('packaged-utf8-response-file',):
    started=time.monotonic()
    arguments=['@recognition.args']
    result=subprocess.run([str(speech/'whisper/whisper-cli.exe'),*arguments],cwd=speech/'whisper',input=audio.getvalue(),capture_output=True,timeout=90)
    recognized=result.stdout.decode('utf-8',errors='replace').strip()
    variants.append({'mode':mode,'exitCode':result.returncode,'recognized':recognized,'stdoutHex':result.stdout.hex(),'seconds':round(time.monotonic()-started,2)})
report={'passed':all(item['exitCode']==0 and 'корпус' in item['recognized'].lower() for item in variants),'platform':sys.platform,'syntheticAudio':True,'physicalPrintersTested':False,'voices':samples,'recognition':variants}
Path('speech-tools-proof.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
assert report['passed']
