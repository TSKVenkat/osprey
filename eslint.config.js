import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The hook rules catch stale closures, which is the bug class that actually
    // bites in the recorder UI.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Loading data in an effect and storing the result is exactly what these
      // pages do. Without a data-fetching library there is nowhere else to put it,
      // and the rules that catch real bugs here — rules-of-hooks and
      // exhaustive-deps — stay on.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
