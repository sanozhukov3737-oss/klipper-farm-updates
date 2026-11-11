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
    # Слова, которые приходят из замен латиницы и из частых фраз ассистента.
    # Без них модель ставит ударение сама: "Криэлити" вместо "Креалити".
    'креалити': 'Кре+алити',
    'флэшфордж': 'Фл+эшфордж',
    'эндер': '+Эндер',
    'кей': 'к+ей',
    'один': 'од+ин',
    'макс': 'м+акс',
    'си': 'с+и',
    'ви': 'в+и',
    'клиппер': 'Кл+иппер',
    'клиппи': 'Кл+иппи',
    'мунрейкер': 'Мунр+ейкер',
    'внимание': 'Вним+ание',
    'проверьте': 'Пров+ерьте',
    'проверь': 'пров+ерь',
    'общий': '+Общий',
    'запускаю': 'Запуск+аю',
    'почти': 'почт+и',
    'пуста': 'пуст+а',
    'выберите': 'Выбер+ите',
    'остановлен': 'остан+овлен',
    'ошибка': 'ош+ибка',
    'переподключается': 'переподключ+ается',
    'доступен': 'дост+упен',
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
    # завершИть: завершИл, завершИтся — на И.
    # Краткие причастия: завершенА, завершенО, завершенЫ — на последнем слоге.
    **{word: word.replace('заверш', 'заверш+', 1) for word in (
        'завершится', 'завершиться', 'завершил', 'завершила', 'завершили',
    )},
    **{word: word.replace('завершен', 'завершен+', 1) for word in (
        'завершена', 'завершено', 'завершены',
    )},
    # Возвратные формы и настоящее время: завершИлся, но завершАется.
    **{word: word.replace('завершил', 'заверш+ил', 1) for word in (
        'завершился', 'завершилась', 'завершилось', 'завершились',
    )},
    **{word: word.replace('заверша', 'заверш+а', 1) for word in (
        'завершается', 'завершаются',
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
    # продОлжить: продОлжил, продОлжила.
    **{word: word.replace('продолж', 'прод+олж', 1) for word in (
        'продолжить', 'продолжил', 'продолжила',
    )},
    # продолжАть и краткие причастия уходят на другой слог.
    'продолжаю': 'продолж+аю',
    'продолжена': 'продолжен+а',
    'продолжено': 'продолжен+о',
    # включИть, включИл — на И; включенА, включенО, включенЫ — на последнем.
    'включена': 'включен+а',
    'включено': 'включен+о',
    'включены': 'включен+ы',
    'включил': 'включ+ил',
    'включила': 'включ+ила',
    'включи': 'включ+и',
    # вЫключить: ударение на Ы во всех формах, в отличие от включИть.
    **{word: word.replace('выключ', 'в+ыключ', 1) for word in (
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
    'минут': 'мин+ут',
    'инструменты': 'инструм+енты',
    'настройки': 'н+астройки',
    'история': 'ист+ория',
    'очередь': '+очередь',
    # Краткие прилагательные и причастия: ударение уходит на окончание.
    **{word: word.replace('гот', 'гот+', 1) for word in (
        'готова', 'готово', 'готовы',
    )},
    'готов': 'гот+ов',
    # закОнчить, закОнчен, закОнчена — ударение остаётся на О.
    **{word: word.replace('законч', 'зак+онч', 1) for word in (
        'закончена', 'закончено', 'закончены',
    )},
    # подключИть: подключён, но подключенА, подключенЫ.
    'подключён': 'подключ+ён',
    'подключена': 'подключен+а',
    'подключено': 'подключен+о',
    'подключены': 'подключен+ы',
    'подключился': 'подключ+ился',
    'подключилась': 'подключ+илась',
    # отменИть: отменён, отмененА, отмененЫ.
    'отменена': 'отменен+а',
    'отменено': 'отменен+о',
    'отменены': 'отменен+ы',
    # минУта, секУнда: ударение на У во всех формах.
    **{word: word.replace('минут', 'мин+ут', 1) for word in (
        'минута', 'минуты', 'минуту', 'минуте', 'минутой',
    )},
    **{word: word.replace('секунд', 'сек+унд', 1) for word in (
        'секунда', 'секунды', 'секунду', 'секундой', 'секунд',
    )},
    # час: часА, часОв, но чАС и чАса в винительном не различить знаком —
    # эти формы оставляем модели.
    'часа': 'час+а',
    'часов': 'час+ов',
    'градусов': 'град+усов',
    'температура': 'температ+ура',
    'температуру': 'температ+уру',
    'прогноз': 'прогн+оз',
    'задание': 'зад+ание',
    'задания': 'зад+ания',
    # Запуск — самое частое слово в репликах ассистента. «запУск» вместо «зАпуск»
    # слышно сразу, поэтому все падежи заданы явно.
    **{word: word.replace('запуск', 'з+апуск', 1) for word in (
        'запуск', 'запуска', 'запуску', 'запуском', 'запуске',
        'запуски', 'запусков', 'запускам', 'запусками', 'запусках',
    )},

    # назовИ, назовИте, уточнИте — повелительное наклонение ударено на И.
    'назови': 'назов+и',
    'назовите': 'назов+ите',
    'уточните': 'уточн+ите',
    'уточнить': 'уточн+ить',
    'скажите': 'скаж+ите',
    'привяжите': 'привяж+ите',
    'повтори': 'повтор+и',
    'повторите': 'повтор+ите',

    # Приставка ВЫ тянет ударение на себя.
    'выбери': 'в+ыбери',
    'выбрать': 'в+ыбрать',
    'выбранного': 'в+ыбранного',
    'выбранный': 'в+ыбранный',
    'выбрано': 'в+ыбрано',

    # Служебные слова и наречия, где модель чаще всего ошибается.
    'сейчас': 'сейч+ас',
    'заново': 'з+аново',
    'удалось': 'удал+ось',
    'пока': 'пок+а',
    'после': 'п+осле',
    'около': '+Около',
    'примерно': 'прим+ерно',
    'сначала': 'снач+ала',
    'часть': 'ч+асть',
    'повторно': 'повторн+о',

    # картОчка: ударение на О во всех формах.
    **{word: word.replace('карточ', 'карт+оч', 1) for word in (
        'карточка', 'карточки', 'карточку', 'карточке', 'карточкой', 'карточек',
    )},

    'точное': 'т+очное',
    'точную': 'т+очную',
    'точный': 'т+очный',
    'название': 'назв+ание',
    'названия': 'назв+ания',
    'какой': 'как+ой',
    'какую': 'как+ую',
    'каком': 'как+ом',
    'список': 'сп+исок',
    'списка': 'сп+иска',
    'поиск': 'п+оиск',
    'поиска': 'п+оиска',
    'план': 'пл+ан',
    'плана': 'пл+ана',
    'сохранить': 'сохран+ить',

    # Подтверждение и состояние запуска.
    'подтверждён': 'подтвержд+ён',
    'изменился': 'измен+ился',
    'изменилась': 'измен+илась',
    'изменилось': 'измен+илось',
    'изменились': 'измен+ились',
    'состояние': 'состо+яние',

    'составьте': 'сост+авьте',
    'составить': 'сост+авить',
    'программы': 'прогр+аммы',
    'проверить': 'пров+ерить',
    'проверку': 'пров+ерку',
    'проверка': 'пров+ерка',
    'помощника': 'пом+ощника',
    'помощник': 'пом+ощник',
    'команду': 'ком+анду',
    'команда': 'ком+анда',
    'найден': 'н+айден',

    'устарел': 'устар+ел',
    'устарели': 'устар+ели',
    'устарела': 'устар+ела',
    'подготовить': 'подгот+овить',
    'подготовку': 'подгот+овку',
    'подготовка': 'подгот+овка',

    'недоступен': 'недост+упен',
    'недоступна': 'недост+упна',
    'недоступно': 'недост+упно',
    'недоступны': 'недост+упны',
    'неизвестен': 'неизв+естен',
    'неизвестно': 'неизв+естно',

    'рассчитать': 'рассчит+ать',
    'нашла': 'нашл+а',
    'запомнила': 'зап+омнила',
    'действие': 'д+ействие',
    'действия': 'д+ействия',
    'прошедшего': 'прош+едшего',
    'подходящий': 'подход+ящий',
    'подходящие': 'подход+ящие',
    'учитывать': 'уч+итывать',

    'данные': 'д+анные',
    'данных': 'д+анных',
    'хватает': 'хват+ает',
    'показаны': 'пок+азаны',
    'первые': 'п+ервые',
    'количество': 'кол+ичество',
    'похожих': 'пох+ожих',
    'истории': 'ист+ории',
    'хранилища': 'хран+илища',
    'повторный': 'повторн+ый',
    'повторная': 'повторн+ая',
    'отправлена': 'отправлен+а',
    'отправляю': 'отправл+яю',
    'ферме': 'ф+ерме',
    # нОмер: встречается в каждой фразе выбора принтера.
    **{word: word.replace('номер', 'н+омер', 1) for word in (
        'номер', 'номера', 'номеру', 'номером', 'номере', 'номера',
    )},
    'содержимое': 'содерж+имое',
    'составления': 'составл+ения',
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


FILE_EXTENSION = re.compile(
    r'.[A-Za-z0-9]{2,5}$',
)


def file_name_speech(name):
    """Произносимая форма имени файла: без каши из склеек и подчёркиваний."""
    # Расширение оставляем: штатный тест синтеза требует сохранять имя файла
    # внутри кавычек как есть. Убираем только нечитаемые элементы.
    extension = ''
    match = FILE_EXTENSION.search(name)
    if match:
        extension = match.group()
        name = name[:match.start()]
    # 57m30s и 4h54m — длительность, а не буквы.
    # Единицы оставляем символами: общий механизм ниже согласует падеж
    # ("четыре часа пятьдесят четыре минуты", а не "четыре час").
    name = re.sub(r'(?<![A-Za-z])([0-9]+)h([0-9]+)m(?![A-Za-z])', r'\1 ч \2 мин', name)
    name = re.sub(r'(?<![A-Za-z])([0-9]+)m([0-9]+)s(?![A-Za-z])', r'\1 мин \2 с', name)
    # Разделители и скобки превращаются в пробел: они не читаются.
    # Содержимое скобок — обычно дубликат копии вида "(5)", на слух он лишний.
    name = re.sub(r'\([^)]*\)', '', name)
    name = re.sub(r'[_\[\]{}+]+', ' ', name)
    name = name.replace('-', ' ')
    # Склейка слов: "СтанокДляСнаряжения" -> "Станок Для Снаряжения".
    name = re.sub(r'(?<=[а-яёА-ЯЁ])(?=[А-ЯЁ])', ' ', name)
    name = re.sub(r'(?<=[A-Za-z])(?=[А-ЯЁ])|(?<=[а-яёА-ЯЁ])(?=[A-Za-z])', ' ', name)
    # Разрыв между словом и числом: "Часть1" -> "Часть 1".
    name = re.sub(r'(?<=[а-яёА-ЯЁA-Za-z])(?=[0-9])', ' ', name)
    name = re.sub(r'(?<=[0-9])(?=[а-яёА-ЯЁA-Za-z])', ' ', name)
    name = re.sub(r'[ ]{2,}', ' ', name).strip()
    return name + extension


def normalize_file_names(text):
    """Нормализует имена файлов внутри защищённых кавычек."""
    def replace(part):
        inner = part[1:-1]
        if not re.search(r'[.][A-Za-z0-9]{2,5}$', inner):
            return part
        return part[0] + file_name_speech(inner) + part[-1]
    return PROTECTED_SPEECH.sub(lambda m: replace(m.group()), text)


def spoken_text(text):
    from num2words import num2words

    # Имена файлов внутри кавычек разбираем первыми: иначе "57m30s" уходит в
    # числовой шаблон и звучит как "пятьдесят семь эм тридцать эс".
    text = normalize_file_names(text)

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
    # Полные модели идут ДО общих слов и ДО обработки чисел: иначе дефис в
    # "Ender-3" попадает в числовой шаблон и звучит как "минус три", а "V3 KE"
    # остаётся латиницей. Ударения проставлены сразу: словарь ASSISTANT_STRESS
    # применяется раньше этих замен и здешних слов не знает.
    for pattern, spoken in [
        (r'\bEnder[\s-]*3[\s-]*V3[\s-]*KE\b', 'Э+ндер три в+и три к+ей'),
        (r'\bEnder[\s-]*3[\s-]*V3\b', 'Э+ндер три в+и три'),
        (r'\bEnder[\s-]*3\b', 'Э+ндер три'),
        (r'\b[kк]\s*1\s*(?:max|макс|мах)\b', 'к+ей од+ин м+акс'),
        (r'\b[kк]\s*1\s*[cс]\b', 'к+ей од+ин с+и'),
        (r'\b[kк]\s*1\b', 'к+ей од+ин'),
        (r'\bKlipper\b', 'Кл+иппер'),
        (r'\bKlippy\b', 'Кл+иппи'),
        (r'\bklippy\.log\b', 'журнала Клиппи'),
        (r'\bMoonraker\b', 'Мунр+ейкер'),
        (r'\bCreality\b', 'Кре+алити'),
        (r'\bFlashforge\b', 'Фл+эшфордж'),
        (r'\bEnder\b', '+Эндер'),
        (r'\bPETG\b', 'пэтг+э'),
        (r'\bPLA\b', 'пэ эл а'),
        (r'\bABS\b', 'а бэ эс'),
    ]:
        text = re.sub(pattern, spoken, text, flags=re.IGNORECASE)
    # Код ошибки вида TE2564 не должен читаться как "тэ е две тысячи...":
    # латинские буквы произносим по одной, цифры остаются числом.
    LATIN_LETTERS = {
        'a': 'эй', 'b': 'би', 'c': 'си', 'd': 'ди', 'e': 'е', 'f': 'эф',
        'g': 'джи', 'h': 'эйч', 'i': 'ай', 'j': 'джей', 'k': 'кей', 'l': 'эл',
        'm': 'эм', 'n': 'эн', 'o': 'оу', 'p': 'пи', 'q': 'кью', 'r': 'эр',
        's': 'эс', 't': 'тэ', 'u': 'ю', 'v': 'ви', 'w': 'дабл ю',
        'x': 'икс', 'y': 'уай', 'z': 'зэд',
    }

    def latin_code(match):
        return ' '.join(LATIN_LETTERS.get(ch.lower(), ch) for ch in match.group())

    text = re.sub(r'\b[A-Z]{2,}[0-9]+\b', latin_code, text)

    # Английский текст ошибки Klipper на слух бесполезен: "Heater extruder not
    # heating at expected rate" превращается в кашу. Убираем длинные латинские
    # слова, короткие (коды вроде KE, MCU) оставляем для чтения по буквам.
    # Расширения файлов убираем вместе с точкой, иначе после удаления латиницы
    # в имени остаётся висящая точка: "принтер печать.gcode" -> "принтер печать."
    # Заглавные аббревиатуры (KE, MCU, ADC) читаются по буквам — это осмысленно.
    text = re.sub(r'\b[A-Z]{2,5}\b', latin_code, text)
    # Любое слово с латиницей в нижнем регистре (not, at, extruder) убираем, но
    # только вне защищённых кавычек: там имена файлов, и их расширение должно
    # сохраниться как есть — это проверяет штатный тест синтеза.
    def drop_latin(part):
        return re.sub(r'\b[A-Za-z]*[a-z][A-Za-z]*\b', ' ', part)
    pieces, cursor = [], 0
    for guarded in PROTECTED_SPEECH.finditer(text):
        pieces.append(drop_latin(text[cursor:guarded.start()]))
        pieces.append(guarded.group())
        cursor = guarded.end()
    pieces.append(drop_latin(text[cursor:]))
    text = ''.join(pieces)
    text = re.sub(r'\s{2,}', ' ', text)
    # После удаления латинских слов остаются висящие точки и запятые.
    text = re.sub(r'[\s]+([.,;:!?])', r'\1', text)
    text = text.strip()

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
        # Секунды нужны для длительности в именах файлов: "57m30s".
        'с': ('f', ['секунда', 'секунды', 'секунд']),
        'сек': ('f', ['секунда', 'секунды', 'секунд']),
        'ч': ('m', ['час', 'часа', 'часов']),
    }

    def quantity(match):
        raw, unit = match.groups()
        gender, forms = units[re.sub(r'\s', '', unit.lower())]
        value = Decimal(raw.replace(',', '.'))
        word = noun(value, forms) if value == value.to_integral_value() else forms[1]
        return f'{number(raw, gender)} {word}'

    text = re.sub(r'(?<!\w)([-+]?\d+(?:[.,]\d+)?)\s*(кг|г|%|°\s*[cс]?|мин|сек|с|ч)(?!\w)', quantity, text, flags=re.IGNORECASE)
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
