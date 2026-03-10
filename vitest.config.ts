import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      include: ['test/**/*.test.{js,ts}'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        exclude: ['test/**', 'node_modules/**'],
        thresholds: {
          lines: 60,
          branches: 55,
        },
      },
    },
  }),
);
