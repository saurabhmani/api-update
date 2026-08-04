import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.vitest.ts', 'src/**/*.vitest.tsx'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@contracts': path.resolve(__dirname, './packages/contracts/src'),
      '@strategy-engine': path.resolve(__dirname, './packages/strategy-engine/src/index.ts'),
      '@risk-engine': path.resolve(__dirname, './packages/risk-engine/src/index.ts'),
      '@market-data': path.resolve(__dirname, './packages/market-data/src/index.ts'),
    },
  },
});
