import { defineConfig } from '@playwright/test';

// End-to-end tests: the built extension in Chromium (from the Nix shell), against a mock Gemini API.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
});
