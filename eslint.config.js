import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'server/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
);
