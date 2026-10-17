import { defineConfig } from 'vitest/config';

// Tests against the real Gemini API. They spend real free-tier quota, so they're separate from
// `npm test` and use Flash-Lite (≈500 requests/day) unless LIVE_MODEL says otherwise.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
  },
});
