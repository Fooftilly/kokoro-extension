import js from '@eslint/js';
import globals from 'globals';

/**
 * High-signal ESLint for extension source + tests.
 * Globals and sourceType are scoped so `no-undef` / parse mode match how files ship.
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
  'no-eval': 'error',
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
  // Classic scripts: SW / content / popup / plain <script src> (no type=module)
  {
    files: [
      'background.js',
      'content.js',
      'popup.js',
      'api-client.js',
      'theme-init.js',
      'transliteration-lite.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: extensionGlobals,
    },
    rules: sharedRules,
  },
  // ES modules: overlay/reader entrypoints and their import graph
  {
    files: [
      'overlay.js',
      'reader.js',
      'audio-manager.js',
      'dom-utils.js',
      'text-processor.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: extensionGlobals,
    },
    rules: sharedRules,
  },
  // Classic scripts that optionally export for Jest via CJS interop
  {
    files: ['content.js', 'api-client.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
      },
    },
  },
  // popup.js uses helpers from api-client.js (classic script globals)
  {
    files: ['popup.js'],
    languageOptions: {
      globals: {
        normalizeVoiceEntry: 'readonly',
        normalizeVoiceIds: 'readonly',
        filterVoicesByPrefix: 'readonly',
        parseVoicesResponse: 'readonly',
        classifyApiFailure: 'readonly',
        messageForKind: 'readonly',
        probeApiConnection: 'readonly',
        fetchNormalizedVoices: 'readonly',
        VOICE_PREFIXES: 'readonly',
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
    rules: {
      ...sharedRules,
      // tests/transliteration.test.js loads the lite module via eval in a harness
      'no-eval': 'off',
    },
  },
];
