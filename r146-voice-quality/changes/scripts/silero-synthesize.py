"""App-local Silero Kseniya: UTF-8 text on stdin, mono PCM16 48 kHz on stdout.

No model downloads, audio files, microphone access, GPU, or resident service.
The model is the same pinned v5_6_ru package used for the selected sample #1.
"""
import array
import contextlib
from decimal import Decimal
import hashlib
from pathlib import Path
import re
import socket
import sys

sys.dont_write_bytecode = True
MODEL_SHA256 = '04cc9b1d08ce38bcaa9d02c488d80d3e6806d17f7eaa7c95982f36a3cbf50b2e'
SAMPLE_RATE = 48_000
MAX_TEXT = 1_200
MAX_SECONDS = 120


def no_network(*_args, **_kwargs):
    raise RuntimeError('Speech synthesis is offline')


socket.create_connection = no_network
socket.socket.connect = no_network
socket.socket.connect_ex = no_network


def spoken_text(text):
    from num2words import num2words

    def number(value, gender='m'):
        value = Decimal(value.replace(',', '.'))
        if abs(value) >= 10 ** 15:
            raise ValueError('Number outside the speech range')
        value = int(value) if value == value.to_integral_value() else format(value.normalize(), 'f')
        return num2words(value, lang='ru', gender=gender)

    def noun(value, forms):
        value = abs(int(value))
        if 11 <= value % 100 <= 14:
            return forms[2]
        return forms[0] if value % 10 == 1 else forms[1] if value % 10 in [2, 3, 4] else forms[2]

    # Preserve the Russian reading of common printer names in assistant replies.
    for pattern, spoken in [
        (r'\b[kк]\s*1\s*(?:max|макс|мах)\b', 'кей один макс'),
        (r'\b[kк]\s*1\s*[cс]\b', 'кей один си'),
        (r'\b[kк]\s*1\b', 'кей один'),
        (r'\bCreality\b', 'Креалити'),
        (r'\bFlashforge\b', 'Флэшфордж'),
        (r'\bEnder\b', 'Эндер'),
        (r'\bPETG\b', 'пэтгэ'),
        (r'\bPLA\b', 'пэ эл а'),
        (r'\bABS\b', 'а бэ эс'),
    ]:
        text = re.sub(pattern, spoken, text, flags=re.IGNORECASE)
    def clock(match):
        hours, minutes = map(int, match.groups())
        return f"{number(str(hours))} {noun(hours, ['час', 'часа', 'часов'])} {number(str(minutes), 'f')} {noun(minutes, ['минута', 'минуты', 'минут'])}"

    text = re.sub(r'\b([0-2]?\d):([0-5]\d)\b', clock, text)
    units = {
        'кг': ('m', ['килограмм', 'килограмма', 'килограммов']),
        'г': ('m', ['грамм', 'грамма', 'граммов']),
        '%': ('m', ['процент', 'процента', 'процентов']),
        '°': ('m', ['градус', 'градуса', 'градусов']),
        '°c': ('m', ['градус Цельсия', 'градуса Цельсия', 'градусов Цельсия']),
        '°с': ('m', ['градус Цельсия', 'градуса Цельсия', 'градусов Цельсия']),
        'мин': ('f', ['минута', 'минуты', 'минут']),
        'ч': ('m', ['час', 'часа', 'часов']),
    }

    def quantity(match):
        raw, unit = match.groups()
        gender, forms = units[re.sub(r'\s', '', unit.lower())]
        value = Decimal(raw.replace(',', '.'))
        word = noun(value, forms) if value == value.to_integral_value() else forms[1]
        return f'{number(raw, gender)} {word}'

    text = re.sub(r'(?<!\w)([-+]?\d+(?:[.,]\d+)?)\s*(кг|г|%|°\s*[cс]?|мин|ч)(?!\w)', quantity, text, flags=re.IGNORECASE)
    text = re.sub(r'(\d+)\s+(минут\w*|секунд\w*|катушк\w*)', lambda m: number(m[1], 'f') + ' ' + m[2], text, flags=re.IGNORECASE)
    text = re.sub(r'[-+]?\d+(?:[.,]\d+)?', lambda m: number(m[0]), text)
    if len(text) > 8_000:
        raise ValueError('Expanded speech text is too long')
    return text


def main():
    data = sys.stdin.buffer.read(MAX_TEXT * 4 + 1)
    if len(data) > MAX_TEXT * 4:
        raise ValueError('Speech text is too long')
    text = data.decode('utf-8').strip()
    if not text or len(text) > MAX_TEXT or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in text):
        raise ValueError('Invalid speech text')
    model_path = Path(__file__).resolve().parent / 'v5_6_ru.pt'
    with model_path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != MODEL_SHA256:
            raise ValueError('The packaged Silero model checksum differs')
    # Only PCM may reach stdout; package diagnostics go to the bounded error pipe.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        torch.set_num_threads(4)
        torch.manual_seed(42)
        model = torch.package.PackageImporter(str(model_path)).load_pickle('tts_models', 'model')
        model.to(torch.device('cpu'))
        with torch.inference_mode():
            audio = model.apply_tts(
                text=spoken_text(text), speaker='kseniya', sample_rate=SAMPLE_RATE,
                put_accent=True, put_stress_homo=True, put_yo=True, put_yo_homo=True,
            ).detach().cpu().reshape(-1)
        if not torch.isfinite(audio).all() or not 1 <= audio.numel() <= MAX_SECONDS * SAMPLE_RATE:
            raise ValueError('Invalid synthesized audio')
        pcm = array.array('h', audio.clamp(-1, 1).mul(32767).round().to(torch.int16).tolist())
        if sys.byteorder != 'little':
            pcm.byteswap()
    sys.stdout.buffer.write(pcm.tobytes())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Local Kseniya voice: {error}', file=sys.stderr)
        raise SystemExit(1)
