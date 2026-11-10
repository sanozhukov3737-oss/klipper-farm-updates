"""Exercise five requests per actual Windows worker, including a Unicode path."""
import array
import io
import json
from pathlib import Path
import queue
import shutil
import struct
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import wave
import zipfile

app = Path(__file__).resolve().parent.parent
speech = app / 'src-tauri/speech'
fixture = Path(sys.argv[1]).resolve()


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise RuntimeError('Worker closed its output pipe')
        result.extend(part)
    return bytes(result)


def response(process, timeout, limit):
    outcome = queue.Queue()

    def read():
        try:
            size = struct.unpack('<I', read_exact(process.stdout, 4))[0]
            if size & 0x80000000 or size > limit:
                raise RuntimeError(f'Invalid response header: {size}')
            outcome.put((read_exact(process.stdout, size), None))
        except Exception as error:
            outcome.put((None, error))
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        data, error = outcome.get(timeout=timeout)
    except queue.Empty:
        process.kill()
        process.wait(timeout=5)
        raise RuntimeError('Speech worker timed out') from None
    if error:
        raise error
    return data


def exercise(root, command, inputs, validate, limit):
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert response(process, 60, limit) == b''
        startup = time.monotonic() - started
        timings = []
        for data in inputs:
            started = time.monotonic()
            process.stdin.write(struct.pack('<I', len(data)) + data)
            process.stdin.flush()
            result = response(process, 30, limit)
            timings.append(round(time.monotonic() - started, 3))
            validate(result)
            assert process.poll() is None, 'Worker exited instead of retaining its model'
        process.stdin.close()
        assert process.wait(timeout=10) == 0, 'Worker did not exit after its app pipe closed'
        return {'startupSeconds': round(startup, 3), 'requestSeconds': timings, 'requestsPassed': len(inputs), 'sameProcess': True, 'exitsOnPipeClose': True}
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()


def check_pcm(data):
    pcm = array.array('h', data)
    assert len(data) % 2 == 0 and len(pcm) > 4800
    assert max(abs(value) for value in pcm) > 100


with zipfile.ZipFile(fixture) as container:
    with wave.open(io.BytesIO(container.read('stock.wav'))) as source:
        assert source.getnchannels() == 1 and source.getsampwidth() == 2 and source.getframerate() == 48000
        samples = array.array('h', source.readframes(source.getnframes()))
        reduced = array.array('h', (int(sum(samples[i:i+3])/3) for i in range(0, len(samples)-2, 3)))
    output = io.BytesIO()
    with wave.open(output, 'wb') as target:
        target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000); target.writeframes(reduced.tobytes())
    recording = output.getvalue()


def check_text(data):
    text = data.decode('utf-8')
    # Воркер отдаёт "уверенность\tтекст". Префикс обязателен: по нему клиент решает,
    # доверять услышанному или переспросить.
    prefix, _, spoken = text.partition('\t')
    confidence = float(prefix)
    assert 0.0 < confidence <= 1.0, text
    spoken = spoken.lower()
    assert 'пластик' in spoken and any(word in spoken for word in ('сколько', 'остал', 'остат', 'запас')), text


def context_recording(context, declared_bytes=None):
    if isinstance(context, str):
        context = context.encode('utf-8')
    return b'KFWHSR01' + struct.pack('<I', len(context) if declared_bytes is None else declared_bytes) + context + recording


def rejects_context_frame(root, command, payload):
    process = subprocess.Popen(command, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert response(process, 60, 8192) == b''
        try:
            process.stdin.write(struct.pack('<I', len(payload)) + payload)
            process.stdin.flush()
        except BrokenPipeError:
            pass  # Oversized outer headers may be rejected before their body is read.
        try:
            response(process, 10, 8192)
        except RuntimeError as error:
            assert 'Invalid response header:' in str(error), error
        else:
            raise AssertionError('Malformed recognition context was accepted')
        assert process.wait(timeout=10) != 0, 'Malformed speech framing must close this worker'
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        process.stdout.close()


def link_or_copy(source, destination):
    try:
        return Path(destination).hardlink_to(source)
    except OSError:
        return shutil.copyfile(source, destination)


with tempfile.TemporaryDirectory(prefix='Ксения быстрые ответы ') as temporary:
    root = Path(temporary) / 'Речевой модуль'
    shutil.copytree(speech, root, copy_function=link_or_copy)
    silero = root / 'silero'
    tts = exercise(silero, [str(silero/'python/python.exe'), '-I', '-X', 'utf8', 'tts.py', '--worker'],
                   [text.encode('utf-8') for text in ['Осталось пять килограммов пластика.', 'Все принтеры свободны.', 'До конца печати двадцать минут.', 'Сопло двести пятьдесят градусов.', 'Осталось пять килограммов пластика.']], check_pcm, 11520000)
    whisper = root / 'whisper'
    # Two consecutive different contexts followed by a legacy request exercise
    # the actual long-lived decoder without carrying the previous vocabulary.
    recognition_inputs = [recording, context_recording('Держатель телефона 12. K1 Max'),
                          context_recording('Кронштейн камеры 25. K1C'), recording,
                          context_recording('Подставка для планшета 18')]
    asr = {
        model: exercise(whisper, [str(whisper/'whisper-worker.exe'), f'ggml-{model}-q5_1.bin'],
                        recognition_inputs, check_text, 8192)
        for model in ('base', 'small')
    }
    invalid_contexts = [context_recording('x' * 1025), context_recording('x' * 513),
                        context_recording(b'\xc0\xaf'), context_recording('Держатель\nтелефона'),
                        context_recording('Камера\u202eназад'), context_recording('Файл', 4096),
                        b'KFWHSR02' + context_recording('Держатель')[8:],
                        b'x' * (640044 + 12 + 1024 + 1)]
    for payload in invalid_contexts:
        rejects_context_frame(whisper, [str(whisper/'whisper-worker.exe'), 'ggml-base-q5_1.bin'], payload)
fast = statistics.median(asr['base']['requestSeconds'])
accurate = statistics.median(asr['small']['requestSeconds'])
assert fast < accurate, 'Fast recognition did not reduce the measured delay'
report = {'passed': True, 'unicodePathVerified': True, 'synthesis': tts, 'recognitionDefault': 'base', 'recognition': asr, 'recognitionSpeedup': round(accurate / max(fast, 0.001), 2),
          'recognitionContext': {'structuredRequestsPerModel': 3, 'legacyRawWaveRequestsPerModel': 2, 'changedContextInSameProcess': True, 'unicodeVocabularyExercised': True, 'malformedFramesRejected': len(invalid_contexts)},
          'physicalMicrophoneTested': False}
(app/'speech-worker-proof.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report))
