import js from '@eslint/js';
import globals from 'globals';

/**
 * High-signal ESLint for extension source + tests.
 * Prefer correctness / foot-gun rules over style churn on an existing codebase.
 */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'assets/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.node,
        ...globals.jest,
        importScripts: 'readonly',
        Readability: 'readonly',
        ePub: 'readonly',
        nlp: 'readonly',
        DOMPurify: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-cond-assign': ['error', 'except-parens'],
      eqeqeq: ['error', 'smart'],
      'no-throw-literal': 'error',
      'no-unsafe-finally': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-redeclare': 'error',
      'no-undef': 'error',
      // Existing codebase — avoid Stage 1 style churn
      'no-var': 'off',
      'prefer-const': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
      'no-misleading-character-class': 'off',
      'preserve-caught-error': 'off',
      'no-eval': 'off',
    },
  },
];
