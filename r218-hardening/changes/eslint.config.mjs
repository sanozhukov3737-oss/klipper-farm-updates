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
      // Забытый await в промисе — молчаливая ошибка, а не стиль. На старте
      // правило в режиме предупреждения: в существующем коде нашлось 27 мест,
      // и менять их все сразу, без поведенческих тестов на каждое, опаснее, чем
      // оставить видимыми. Новый код должен быть чистым.
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Неиспользуемое с подчёркиванием — осознанное решение автора.
      // ignoreRestSiblings: `const {apiKey, ...rest} = value` — это отбрасывание
      // полей перед сохранением, а не неиспользуемая переменная.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // any в этом проекте почти всегда означает неразобранный ответ Moonraker,
      // поэтому это предупреждение, а не запрет.
      '@typescript-eslint/no-explicit-any': 'warn',
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
