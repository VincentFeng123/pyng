import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      'client/src/overlay/overlay.js',
      'client/src/overlay/tracking-math.js',
      'client/src/overlay/components/edge-arrow.js',
      'client/src/main/overlay-preload.cjs',
      'client/src/main/ocr/worker.js',
      'client/src/renderer/settings.js',
      'client/src/main/settings-preload.cjs',
      'client/src/renderer/main.js',
      'client/src/main/main-preload.cjs',
      'client/src/main/index.cjs',
    ],
  },
  js.configs.recommended,
  {
    // Plain Node scripts (.mjs/.cjs/.js used as one-shot tooling, not part of
    // a workspace's tsconfig include). Declare Node runtime globals so the
    // base no-undef rule doesn't reject Buffer/process/etc.
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./shared/tsconfig.json', './server/tsconfig.json', './client/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': ['warn', { ignoreRestArgs: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'prefer-const': 'error',
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  prettierConfig,
];
