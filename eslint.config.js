import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['server/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'off',
      'no-empty': 'off',
      'no-redeclare': 'off',
      'no-duplicate-case': 'off',
      'no-useless-escape': 'off',
      'no-dupe-class-members': 'off',
      'no-dupe-keys': 'off',
      'no-case-declarations': 'off',
    },
  },
  {
    files: ['server/integrations/dapp/programmableMoneyEngine.js', 'server/routes/programmableMoney.js'],
    rules: {
      'no-empty': 'error',
      'no-redeclare': 'error',
      'no-duplicate-case': 'error',
      'no-useless-escape': 'error',
      'no-dupe-class-members': 'error',
      'no-case-declarations': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'public/**', 'contracts/**', 'android/**', 'docs/**', 'dapp/**'],
  },
];
