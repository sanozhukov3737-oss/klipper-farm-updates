"""Offline speech-boundary regressions; no torch/model download or audio device."""
import contextlib
import importlib.util
from pathlib import Path
import types
import unittest

SPEC = importlib.util.spec_from_file_location('speech', Path(__file__).with_name('silero-synthesize.py'))
speech = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(speech)


class PronunciationTests(unittest.TestCase):
    def test_empty_printer_reply_has_explicit_status_stress(self):
        original = 'Свободных принтеров сейчас нет.'
        self.assertEqual(speech.spoken_text(original), 'Своб+одных пр+интеров сейч+ас нет.')
        self.assertEqual(original, 'Свободных принтеров сейчас нет.')

    def test_common_reply_vocabulary_retains_case_and_punctuation(self):
        self.assertEqual(speech.pronunciation_text('ПРИНТЕР свободен. На катушке осталось немного пластика. Печатает.'),
                         'ПР+ИНТЕР своб+оден. На кат+ушке ост+алось немн+ого пл+астика. Печ+атает.')

    def test_quoted_custom_names_and_incomplete_quotes_are_left_to_model(self):
        for value in ['«Принтер Свободный»', '“Принтер Свободный”', '"Принтер Свободный"',
                      "'Принтер Свободный'", '«Принтер Свободный', '"Принтер Свободный']:
            with self.subTest(value=value):
                self.assertEqual(speech.pronunciation_text('Свободен ' + value), 'Своб+оден ' + value)
        self.assertEqual(speech.spoken_text('Печать «принтер печать.gcode».'), 'Печ+ать «принтер печать.gcode».')

    def test_paths_urls_and_file_tokens_are_not_used_as_narration(self):
        values = ['принтер.gcode', 'печать.STL', 'folder/печать.gcode', '/катушка/печать',
                  r'C:\катушка\печать.gcode', 'https://example.invalid/печать']
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(speech.pronunciation_text(value + ' принтер'), value + ' пр+интер')

    def test_explicit_stress_is_preserved_and_unicode_acute_is_supported(self):
        self.assertEqual(speech.pronunciation_text('Пр+интер своб+оден.'), 'Пр+интер своб+оден.')
        self.assertEqual(speech.spoken_text('Принт+ер свобод+ен.'), 'Принт+ер свобод+ен.')
        self.assertEqual(speech.pronunciation_text('Принте\u0301р свободе\u0301н.'), 'Принт+ер свобод+ен.')
        self.assertEqual(speech.pronunciation_text('Ёж и всё.'), 'Ёж и всё.')

    def test_action_and_navigation_vocabulary_has_explicit_stress(self):
        self.assertEqual(speech.pronunciation_text('Открыла Мою флешку. Печать завершена. Ошибка принтера.'),
                         'Откр+ыла Мою фл+ешку. Печ+ать завершен+а. Ош+ибка пр+интера.')
        self.assertEqual(speech.pronunciation_text('Подсветка включена. Печать продолжена. Остаток пластика.'),
                         'Подсв+етка включен+а. Печ+ать прод+олжена. Ост+аток пл+астика.')
        self.assertEqual(speech.pronunciation_text('Покажи камеру. Закончился филамент. Файл, модель, деталь, библиотека.'),
                         'Покаж+и к+амеру. Зак+ончился фил+амент. Ф+айл, мод+ель, дет+аль, библиот+ека.')

    def test_completion_verbs_stress_the_final_syllable_of_the_stem(self):
        # Жалоба с фермы: «Печать скоро завершится» звучало как «завЕршится».
        # В глаголах на -ить ударение на И, в кратких причастиях — на окончании.
        cases = {
            'Печать скоро завершится.': 'Печ+ать ск+оро заверш+ится.',
            'Печать завершилась.': 'Печ+ать заверш+илась.',
            'Печать завершена.': 'Печ+ать завершен+а.',
        }
        for original, expected in cases.items():
            with self.subTest(phrase=original):
                self.assertEqual(speech.pronunciation_text(original), expected)

    def test_forms_outside_the_vocabulary_are_left_to_the_model(self):
        # Ассистент таких форм не произносит: их нет в строках интерфейса.
        # Таблица не должна угадывать за модель, поэтому знака здесь не появляется.
        cases = {'Печать завершается.': 'завершается', 'Лампа выключил.': 'выключил'}
        for phrase, word in cases.items():
            with self.subTest(phrase=phrase):
                self.assertNotIn('+', speech.pronunciation_text(phrase).split(' ')[-1])

    def test_switches_stress_the_prefix_and_inside_the_verb(self):
        # включИть и вЫключить ударены по-разному: это не опечатка словаря.
        cases = {
            'Подсветка включена.': 'Подсв+етка включен+а.',
            'Лампа выключена.': 'Лампа в+ыключена.',
            'Пауза продолжена.': 'П+ауза прод+олжена.',
        }
        for original, expected in cases.items():
            with self.subTest(phrase=original):
                self.assertEqual(speech.pronunciation_text(original), expected)

    def test_every_stress_entry_matches_its_own_word(self):
        # Инвариант словаря: один знак ударения, перед гласной, и форма без знака
        # совпадает с ключом. Ловит опечатки вроде 'заверш+иится'.
        vowels = 'аеёиоуыэюя'
        for word, stressed in speech.ASSISTANT_STRESS.items():
            with self.subTest(word=word):
                self.assertEqual(stressed.count('+'), 1, 'ровно один знак ударения')
                index = stressed.index('+')
                self.assertIn(stressed[index + 1:index + 2].lower(), vowels,
                              'знак ударения стоит перед гласной')
                self.assertEqual(stressed.replace('+', '').lower(), word,
                                 'форма без ударения совпадает с ключом')

    def test_unknown_words_and_homographs_are_not_guessed(self):
        text = 'Замки заперты. Н+овая супермодель и микропринтер, принтерный, принтер_имя и принтер2.'
        self.assertEqual(speech.pronunciation_text(text), text)

    def test_existing_printer_names_and_numeric_inflection_still_work(self):
        text = speech.spoken_text('Принтер K1 Max: осталось 23 минуты. Сопло 250°C. Запас 1.500 кг. Время 20:34.')
        # Числа больше не теряют ударение: минуты, градусы и часы есть в словаре.
        # Эталон закрепляет и числительные, и названия единиц.
        for value in ['Пр+интер к+ей од+ин м+акс', 'ост+алось дв+адцать три мин+уты',
                      'Сопл+о двести пятьдесят гр+адусов Ц+ельсия',
                      'Зап+ас одн+а целая пять десятых килогр+амма',
                      'Вр+емя дв+адцать час+ов тр+идцать четыре мин+уты']:
            self.assertIn(value, text)

    def test_actual_synthesizer_boundary_receives_spoken_copy_and_keeps_flags(self):
        calls = []

        class Tensor:
            def detach(self): return self
            def cpu(self): return self
            def reshape(self, *_args): return self
            def numel(self): return 2
            def clamp(self, *_args): return self
            def mul(self, *_args): return self
            def round(self): return self
            def to(self, *_args): return self
            def tolist(self): return [100, -100]

        def apply_tts(**kwargs):
            calls.append(kwargs)
            return Tensor()

        torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext, manual_seed=lambda _seed: None,
                                      isfinite=lambda _audio: types.SimpleNamespace(all=lambda: True), int16='int16')
        synthesize = speech.synthesizer(torch, types.SimpleNamespace(apply_tts=apply_tts))
        original = 'Свободных принтеров сейчас нет. Файл «печать.gcode».'
        result = synthesize(original)
        self.assertEqual(synthesize(original), result)
        self.assertEqual(len(result), 4)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['text'], 'Своб+одных пр+интеров сейч+ас нет. Ф+айл «печать.gcode».')
        self.assertEqual(calls[0]['speaker'], 'kseniya')
        self.assertEqual(calls[0]['sample_rate'], 48000)
        for flag in ['put_accent', 'put_stress_homo', 'put_yo', 'put_yo_homo']:
            self.assertIs(calls[0][flag], True)
        self.assertEqual(original, 'Свободных принтеров сейчас нет. Файл «печать.gcode».')


if __name__ == '__main__':
    unittest.main()
