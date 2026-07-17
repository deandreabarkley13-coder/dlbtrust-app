import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: {
      DATABASE_PATH: ':memory:',
      JWT_SECRET: 'test-secret',
    },
  },
});
