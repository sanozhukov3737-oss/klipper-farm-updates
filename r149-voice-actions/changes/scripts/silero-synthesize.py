"""App-local Silero Kseniya: UTF-8 text on stdin, mono PCM16 48 kHz on stdout.

No model downloads, audio files, microphone access, GPU, or resident service.
The model is the same pinned v5_6_ru package used for the selected sample #1.
"""
import array
import contextlib
from decimal import Decimal
import hashlib
import os
from pathlib import Path
import re
import socket
import struct
import sys
from functools import lru_cache

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


# Only ordinary assistant vocabulary: ambiguous words and arbitrary names stay
# with the model. Silero marks stress with '+' BEFORE the stressed vowel.
# https://github.com/snakers4/silero-models/wiki/SSML
ASSISTANT_STRESS = {
    **{word: word.replace('прин', 'пр+ин', 1) for word in (
        'принтер', 'принтера', 'принтеру', 'принтером', 'принтере',
        'принтеры', 'принтеров', 'принтерам', 'принтерами', 'принтерах',
    )},
    **{word: word.replace('свобод', 'своб+од', 1) for word in (
        'свободен', 'свободна', 'свободно', 'свободны', 'свободный',
        'свободная', 'свободное', 'свободные', 'свободного', 'свободному',
        'свободным', 'свободных', 'свободными',
    )},
    **{word: word.replace('печат', 'печ+ат', 1) for word in (
        'печать', 'печати', 'печатью', 'печатать', 'печатает', 'печатают',
        'печатается', 'печатаются', 'печатал', 'печатала', 'печатали',
    )},
    **{word: word.replace('катуш', 'кат+уш', 1) for word in (
        'катушка', 'катушки', 'катушке', 'катушку', 'катушкой', 'катушек',
        'катушкам', 'катушками', 'катушках',
    )},
    **{word: word.replace('пласт', 'пл+аст', 1) for word in (
        'пластик', 'пластика', 'пластику', 'пластиком', 'пластике',
    )},
    **{word: word.replace('оста', 'ост+а', 1) for word in (
        'осталось', 'остался', 'осталась', 'остались',
    )},
    **{word: word.replace('заверш', 'зав+ерш', 1) for word in (
        'завершена', 'завершено', 'завершены', 'завершится', 'завершиться',
        'завершил', 'завершила', 'завершили',
    )},
    **{word: word.replace('законч', 'зак+онч', 1) for word in (
        'закончит', 'закончится', 'закончатся', 'закончил', 'закончила', 'закончили',
        'закончился', 'закончилась', 'закончилось', 'закончились',
    )},
    **{word: word.replace('освобод', 'освоб+од', 1) for word in (
        'освободится', 'освободился', 'освободилась', 'освободились',
    )},
    'подтвердил': 'подтверд+ил',
    'подтвердила': 'подтверд+ила',
    'подтвердили': 'подтверд+или',
    'подтверждена': 'подтвержден+а',
    'подтверждено': 'подтвержден+о',
    'подтверждены': 'подтвержден+ы',
    'подтверждаю': 'подтвержд+аю',
    **{word: word.replace('шиб', 'ш+иб', 1) for word in (
        'ошибка', 'ошибки', 'ошибке', 'ошибку', 'ошибкой', 'ошибок',
        'ошибкам', 'ошибками', 'ошибках',
    )},
    **{word: word.replace('камер', 'к+амер', 1) for word in (
        'камера', 'камеры', 'камеру', 'камерой', 'камере',
    )},
    **{word: word.replace('флеш', 'фл+еш', 1) for word in (
        'флешка', 'флешки', 'флешке', 'флешку', 'флешкой',
    )},
    **{word: word.replace('филамент', 'фил+амент', 1) for word in (
        'филамент', 'филамента', 'филаменту', 'филаментом', 'филаменте',
    )},
    **{word: word.replace('библиот', 'библи+от', 1) for word in (
        'библиотека', 'библиотеки', 'библиотеку', 'библиотекой', 'библиотеке',
        'библиотек', 'библиотекам', 'библиотеками', 'библиотеках',
    )},
    **{word: word.replace('файл', 'ф+айл', 1) for word in (
        'файл', 'файла', 'файлу', 'файлом', 'файле',
        'файлы', 'файлов', 'файлам', 'файлами', 'файлах',
    )},
    **{word: word.replace('модел', 'м+одел', 1) for word in (
        'модель', 'модели', 'моделью', 'моделей', 'моделям', 'моделями', 'моделях',
    )},
    **{word: word.replace('детал', 'д+етал', 1) for word in (
        'деталь', 'детали', 'деталью', 'деталей', 'деталям', 'деталями', 'деталях',
    )},
    **{word: word.replace('доступ', 'дост+уп', 1) for word in (
        'доступен', 'доступна', 'доступно', 'доступны', 'доступный',
        'доступная', 'доступное', 'доступные',
    )},
    **{word: word.replace('подсвет', 'подсв+ет', 1) for word in (
        'подсветка', 'подсветки', 'подсветку', 'подсветкой', 'подсветке',
    )},
    **{word: word.replace('пауз', 'п+ауз', 1) for word in (
        'пауза', 'паузы', 'паузу', 'паузой', 'паузе',
    )},
    **{word: word.replace('продолж', 'прод+олж', 1) for word in (
        'продолжена', 'продолжено', 'продолжить', 'продолжаю', 'продолжил', 'продолжила',
    )},
    **{word: word.replace('люч', 'л+юч', 1) for word in (
        'включена', 'включено', 'включены', 'включила', 'включил', 'включи',
    )},
    **{word: word.replace('люч', 'л+юч', 1) for word in (
        'выключена', 'выключено', 'выключены', 'выключила', 'выключил', 'выключи',
    )},
    **{word: word.replace('запас', 'зап+ас', 1) for word in (
        'запас', 'запаса', 'запасу', 'запасом', 'запасе',
    )},
    **{word: word.replace('остат', 'ост+ат', 1) for word in (
        'остаток', 'остатка', 'остатку', 'остатком', 'остатке',
        'остатки', 'остатков', 'остаткам', 'остатками', 'остатках',
    )},
    'грамм': 'гр+амм',
    'минут': 'м+инут',
    'инструменты': 'инструм+енты',
    'настройки': 'н+астройки',
    'история': '+история',
    'очередь': '+очередь',
}
PROTECTED_SPEECH = re.compile(
    r'«[^»]*(?:»|$)|“[^”]*(?:”|$)|"[^"]*(?:"|$)|'
    r"'[^']*(?:'|$)|"
    r'(?:https?://|[a-z]:[\\/]|[./\\])[^\s«»“”"\']*|'
    r'(?<!\w)[^\s«»“”"\']+\.(?:gcode|gco|3mf|stl|obj)(?!\w)[^\s«»“”"\']*',
    re.IGNORECASE,
)


def pronunciation_text(text):
    """Stress ordinary narration, retaining quoted names and explicit stress."""
    def narration(part):
        def token(match):
            word = match.group()
            if '+' in word:
                return word
            if '\u0301' in word:
                return re.sub(r'([аеиоуыэюяёАЕИОУЫЭЮЯЁ])\u0301', r'+\1', word)
            stressed = ASSISTANT_STRESS.get(word.lower())
            if stressed is None:
                return word
            # Insert into the original token to retain its capitalisation.
            index = stressed.index('+')
            return word[:index] + '+' + word[index:]
        return re.sub(r'(?<![\w+])[а-яё\u0301+]+(?![\w+])', token, part, flags=re.IGNORECASE)

    parts, start = [], 0
    for match in PROTECTED_SPEECH.finditer(text):
        parts.extend((narration(text[start:match.start()]), match.group()))
        start = match.end()
    parts.append(narration(text[start:]))
    return ''.join(parts)


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
    text = pronunciation_text(text)
    if len(text) > 8_000:
        raise ValueError('Expanded speech text is too long')
    return text


def validate_text(data):
    if len(data) > MAX_TEXT * 4:
        raise ValueError('Speech text is too long')
    text = data.decode('utf-8').strip()
    if not text or len(text) > MAX_TEXT or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in text):
        raise ValueError('Invalid speech text')
    return text


def load_model():
    model_path = Path(__file__).resolve().parent / 'v5_6_ru.pt'
    # Only PCM may reach stdout; package diagnostics go to the bounded error pipe.
    with model_path.open('rb') as stream, contextlib.redirect_stdout(sys.stderr):
        if hashlib.file_digest(stream, 'sha256').hexdigest() != MODEL_SHA256:
            raise ValueError('The packaged Silero model checksum differs')
        stream.seek(0)
        import torch
        torch.set_num_threads(min(4, max(1, (os.cpu_count() or 2) // 2)))
        torch.manual_seed(42)
        # PyTorch 2.5's filename reader uses narrow fopen on Windows. Python's
        # Unicode-safe open plus the supported file-object reader also works
        # when the installation path contains Russian letters or spaces.
        model = torch.package.PackageImporter(stream).load_pickle('tts_models', 'model')
        model.to(torch.device('cpu'))
    return torch, model


def synthesizer(torch, model):
    @lru_cache(maxsize=4)
    def synthesize(text):
        with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
            torch.manual_seed(42)
            audio = model.apply_tts(
                text=spoken_text(text), speaker='kseniya', sample_rate=SAMPLE_RATE,
                put_accent=True, put_stress_homo=True, put_yo=True, put_yo_homo=True,
            ).detach().cpu().reshape(-1)
        if not torch.isfinite(audio).all() or not 1 <= audio.numel() <= MAX_SECONDS * SAMPLE_RATE:
            raise ValueError('Invalid synthesized audio')
        pcm = array.array('h', audio.clamp(-1, 1).mul(32767).round().to(torch.int16).tolist())
        if sys.byteorder != 'little':
            pcm.byteswap()
        return pcm.tobytes()
    return synthesize


def write_frame(data, error=False):
    sys.stdout.buffer.write(struct.pack('<I', len(data) | (0x80000000 if error else 0)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_exact(size):
    result = bytearray()
    while len(result) < size:
        part = sys.stdin.buffer.read(size - len(result))
        if not part:
            raise EOFError('Speech input pipe closed')
        result.extend(part)
    return bytes(result)


def main():
    worker = sys.argv[1:] == ['--worker']
    # Reject malformed one-shot input before importing the model.
    text = None if worker else validate_text(sys.stdin.buffer.read(MAX_TEXT * 4 + 1))
    synthesize = synthesizer(*load_model())
    if not worker:
        sys.stdout.buffer.write(synthesize(text))
        return
    synthesize('Готово.')  # Warm compute once before reporting readiness.
    write_frame(b'')
    while True:
        try:
            size = struct.unpack('<I', read_exact(4))[0]
            if not 1 <= size <= MAX_TEXT * 4:
                raise ValueError('Invalid speech frame size')
            data = read_exact(size)
        except EOFError:
            return  # The application closed its pipe: no resident background service.
        try:
            write_frame(synthesize(validate_text(data)))
        except (ValueError, RuntimeError) as error:
            write_frame(str(error).encode('utf-8')[:4096], error=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Local Kseniya voice: {error}', file=sys.stderr)
        raise SystemExit(1)
