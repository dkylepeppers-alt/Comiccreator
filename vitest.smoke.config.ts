import { defineConfig } from 'vitest/config';

/**
 * Live smoke probes. Excluded from the normal suite and from CI because they need a
 * real NANOGPT_API_KEY and bill real requests. Run explicitly:
 *
 *   NANOGPT_API_KEY=... npx vitest run --config vitest.smoke.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['scripts/*-smoke.ts'],
  },
});
