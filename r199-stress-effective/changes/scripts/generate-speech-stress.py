#!/usr/bin/env python3
"""Генерирует словарь ударений для синтеза речи из проверенного источника.

Зачем это нужно. Раньше ударения задавались рукой, группами по основе слова. Такой
подход ошибается на формах, где ударение уходит с основы, и его невозможно проверить:
глазами видно только то, что уже написано. Сверка с эталонным словарём показала десять
ошибок в ста шестидесяти записях, часть из них звучала в эфире.

Теперь таблицу строит машина из словаря ruaccent (лицензия MIT, 3,19 млн словоформ).
Человек читает не исходник, а diff: он короткий и проверяемый.

Что берём:
  * только слова, которые ассистент действительно произносит — они лежат в исходниках;
    произвольную лексику не подмешиваем, иначе таблица начнёт решать за модель там,
    где контекст важнее словаря;
  * только слова от четырёх букв: короткие служебные слова не бывают под ударением
    неверно, а знак в них только мешает;
  * ничего с буквой ё — она уже означает ударение;
  * ни одного омографа из списка ruaccent: у «все/всё» и подобных выбор зависит от
    смысла, и закреплять одно чтение значит сделать другое неверным.

Что остаётся рукой: транслитерации названий принтеров. В эталоне их нет, поэтому
они перечислены отдельно и не перетираются генерацией.

Использование:
    python scripts/generate-speech-stress.py --dictionary accents_full.json \\
        --dictionary-omographs accents.json --check

    --check  не пишет файл, а падает, если таблица разошлась с эталоном.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEECH = ROOT / 'scripts' / 'silero-synthesize.py'

# Слова, которые приложение может произнести. Берём все русские строки интерфейса:
# любая из них может попасть в уведомление, а уведомление озвучивается. Ограничивать
# список файлами озвучки нельзя — «Подсветка включена» лежит в ControlPanel.tsx.
SOURCE_DIR = 'src'

# Единицы и их склонения не встречаются в литералах: их подставляет согласование
# числа в рантайме. Без них «23 минуты» произносится без ударения.
RUNTIME_WORDS = (
    # Единицы и их склонения.
    'час', 'часа', 'часов', 'минута', 'минуты', 'минут', 'минуту',
    'секунда', 'секунды', 'секунд', 'секунду',
    'грамм', 'грамма', 'граммов', 'килограмм', 'килограмма', 'килограммов',
    'процент', 'процента', 'процентов', 'градус', 'градуса', 'градусов',
    'цельсия',
    # Числительные. Их подставляет num2words при озвучивании, в строках
    # интерфейса их нет, поэтому без этого списка модель угадывает ударение:
    # «двенАдцать» вместо «двен+адцать».
    'один', 'одна', 'одно', 'два', 'две', 'три', 'четыре', 'пять',
    'шесть', 'семь', 'восемь', 'девять', 'десять',
    'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
    'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
    'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят',
    'семьдесят', 'восемьдесят', 'девяносто',
    'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот',
    'семьсот', 'восемьсот', 'девятьсот',
    'тысяча', 'тысячи', 'тысяч', 'миллион', 'миллиона', 'миллионов',
    # Дробные и порядковые: «одна целая пять десятых».
    'целая', 'целых', 'десятая', 'десятых', 'сотая', 'сотых',
    'половина', 'половины', 'половину',
)

BEGIN = '# >>> speech-stress generated'
END = '# <<< speech-stress generated'

WORD = re.compile(r'[а-яё]{3,}', re.IGNORECASE)
STRING = re.compile(r"""[`'"]([^`'"\n]{12,400})[`'"]""")


def spoken_words() -> set[str]:
    """Русские слова из строк интерфейса, кроме подстановок ${...}."""
    words: set[str] = set()
    files = sorted((ROOT / SOURCE_DIR).rglob('*'))
    if not files:
        raise SystemExit('Не найден каталог исходников: ' + SOURCE_DIR)
    for path in files:
        if path.suffix not in ('.ts', '.tsx') or not path.is_file():
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        for match in STRING.finditer(text):
            literal = re.sub(r'\$\{[^}]*\}', ' ', match.group(1))
            for word in WORD.findall(literal.lower()):
                words.add(word)
    return words


def load(path: Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise SystemExit('Ожидался объект JSON: ' + str(path))
    return data


def build(dictionary: dict, omographs: set[str], manual: dict) -> tuple[dict, list[str]]:
    """Возвращает таблицу и список пропущенных слов вместе с причиной."""
    table: dict[str, str] = {}
    skipped: list[str] = []
    for word in sorted(spoken_words() | set(RUNTIME_WORDS)):
        if word in manual:
            table[word] = manual[word]
            continue
        if 'ё' in word:
            skipped.append(f'{word}: содержит ё, ударение уже обозначено')
            continue
        if word in omographs:
            skipped.append(f'{word}: омограф, чтение зависит от смысла')
            continue
        stressed = dictionary.get(word)
        if not isinstance(stressed, str) or '+' not in stressed:
            skipped.append(f'{word}: нет в эталоне')
            continue
        if stressed.replace('+', '').lower() != word:
            skipped.append(f'{word}: эталон дал другую форму ({stressed})')
            continue
        table[word] = stressed
    return table, skipped


def manual_overrides() -> dict:
    """Транслитерации и термины, которых нет в эталоне."""
    spec = importlib.util.spec_from_file_location('speech', SPEECH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return dict(module.MANUAL_STRESS)


def render(table: dict, manual: dict) -> str:
    lines = [
        BEGIN,
        '# Сгенерировано scripts/generate-speech-stress.py из словаря ruaccent (MIT).',
        '# Руками не править: измените MANUAL_STRESS ниже или запустите генератор.',
        'ASSISTANT_STRESS = {',
    ]
    for word in sorted(table):
        if word in manual:
            continue
        lines.append(f"    {word!r}: {table[word]!r},")
    lines.append('}')
    lines.append('')
    lines.append('# Транслитерации названий принтеров: в эталоне их нет, заданы вручную.')
    lines.append('ASSISTANT_STRESS.update({')
    for word in sorted(manual):
        lines.append(f"    {word!r}: {manual[word]!r},")
    lines.append('})')
    lines.append(END)
    return '\n'.join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dictionary', required=True, type=Path,
                        help='accents_full.json из ruaccent')
    parser.add_argument('--dictionary-omographs', required=True, type=Path,
                        help='accents.json из ruaccent: список омографов')
    parser.add_argument('--check', action='store_true',
                        help='проверить таблицу, файл не менять')
    parser.add_argument('--report', action='store_true', help='напечатать пропуски')
    args = parser.parse_args()

    dictionary = load(args.dictionary)
    omographs = set(load(args.dictionary_omographs))
    manual = manual_overrides()
    table, skipped = build(dictionary, omographs, manual)

    if args.report:
        for row in skipped:
            print('  пропуск:', row)

    block = render(table, manual)
    source = SPEECH.read_text(encoding='utf-8')
    start, end = source.find(BEGIN), source.find(END)
    if start < 0 or end < 0:
        raise SystemExit('В silero-synthesize.py нет блока ' + BEGIN)

    if args.check:
        current = source[start:end + len(END)]
        if current != block:
            raise SystemExit('Таблица ударений разошлась с эталоном. '
                             'Запустите генератор без --check.')
        print(f'Таблица ударений совпадает с эталоном: {len(table)} записей.')
        return 0

    updated = source[:start] + block + source[end + len(END):]
    if updated != source:
        SPEECH.write_text(updated, encoding='utf-8', newline='')
    print(f'Записано {len(table)} записей '
          f'({len(manual)} вручную, {len(table) - len(manual)} из эталона).')
    if skipped:
        print(f'Пропущено {len(skipped)} слов; --report покажет причины.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
