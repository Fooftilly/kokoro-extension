import js from '@eslint/js';
import globals from 'globals';

/**
 * High-signal ESLint for extension source + tests.
 * Globals are scoped so `no-undef` can catch Node-only APIs in browser scripts.
 */
const sharedRules = {
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
};

const extensionGlobals = {
  ...globals.browser,
  ...globals.webextensions,
  importScripts: 'readonly',
  Readability: 'readonly',
  ePub: 'readonly',
  nlp: 'readonly',
  DOMPurify: 'readonly',
};

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
    files: [
      'background.js',
      'content.js',
      'popup.js',
      'overlay.js',
      'reader.js',
      'audio-manager.js',
      'dom-utils.js',
      'text-processor.js',
      'theme-init.js',
      'transliteration-lite.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: extensionGlobals,
    },
    rules: sharedRules,
  },
  // content.js optionally exports for Jest via CJS interop (not a general Node surface)
  {
    files: ['content.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
      },
    },
  },
  {
    files: ['build.js', 'jest.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: sharedRules,
  },
  {
    files: ['tests/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        ...globals.webextensions,
        Readability: 'readonly',
        ePub: 'readonly',
        nlp: 'readonly',
        DOMPurify: 'readonly',
      },
    },
    rules: sharedRules,
  },
];
