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
      // Node runs .ts directly by stripping types, and it cannot strip a parameter
      // property: it is syntax that emits code. A class using one typechecks, passes
      // tests through a bundler, and then refuses to start under Node.
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
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
