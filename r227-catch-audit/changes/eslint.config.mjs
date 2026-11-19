// Проверка кода, а не оформления: правила стиля здесь намеренно не включены,
// иначе первая же тысяча замечаний о кавычках утопит настоящие ошибки.
// Задача этого файла — ловить то, что не видит tsc: потерянный await,
// неиспользуемые переменные, сравнение через == и забытые зависимости хуков.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Собранное, зависимости и исходники из архива не проверяем.
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/target/**', '.klipper-build-cache/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    // Правила о потерянных промисах требуют типов, а значит программы разбора.
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Забытый await в промисе — молчаливая ошибка, а не стиль. Правило было
      // предупреждением, пока в коде оставалось 27 таких мест; они исправлены,
      // поэтому теперь это ошибка и сборка не пройдёт.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Неиспользуемое с подчёркиванием — осознанное решение автора.
      // ignoreRestSiblings: `const {apiKey, ...rest} = value` — это отбрасывание
      // полей перед сохранением, а не неиспользуемая переменная.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // Пустой блок catch скрывает решение: то ли ошибку продумали и она
      // не важна, то ли её просто не заметили. Требуем написать причину
      // внутри блока — тогда это видно при чтении, а не выясняется на ферме.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // any допустим только на границе JSON, где форма ответа уточняется при
      // чтении. Везде ещё он запрещён; законные исключения помечены
      // eslint-disable с причиной рядом.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      // Проверочные скрипты пишутся как проверки: неиспользуемые там недопустимы.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
