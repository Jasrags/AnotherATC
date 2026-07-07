// Flat config. General TypeScript linting plus a hard boundary that keeps the
// sim core (Layer 1) headless — it must never import UI/DOM.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Node ingestion/build scripts.
    files: ['tools/**/*.mjs', 'tools/**/*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['packages/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
              message: 'Sim core must stay headless — no React imports (Layer 1).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Sim core must stay headless — no DOM globals.' },
        { name: 'document', message: 'Sim core must stay headless — no DOM globals.' },
      ],
    },
  },
)
