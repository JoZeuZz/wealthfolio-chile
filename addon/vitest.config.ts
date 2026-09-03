import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@ui': r('./src/ui'),
      '@services': r('./src/services'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The core suite runs in Node; each React test file declares
    // `@vitest-environment jsdom` in its own docblock. Keeping the default at
    // `node` means a DOM exists only where a test asked for one, so nothing in
    // `core/` can start depending on `window` by accident — and the 400-odd
    // pure tests do not pay for a DOM they never touch.
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
