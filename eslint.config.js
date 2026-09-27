import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export const base = tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);

export default base;
