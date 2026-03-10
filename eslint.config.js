import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/js/**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        Image: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        Uint8Array: 'readonly',
        AbortController: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
        atob: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        indexedDB: 'readonly',
        IDBKeyRange: 'readonly',
        Promise: 'readonly',
        crypto: 'readonly',
        caches: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',

        // App global (set on window by app.ts, used by page modules at runtime)
        App: 'readonly',

        // Vite build-time define (replaced at build time)
        __APP_VERSION__: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unreachable': 'error',
      'eqeqeq': ['warn', 'smart'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-throw-literal': 'error',
    },
  },
);
