import { defineConfig, devices } from '@playwright/test';
import { ORIGIN } from './src/lib/config';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: ORIGIN },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'pnpm build && node build/index.js',
    env: { HOST: '127.0.0.1', PORT: new URL(ORIGIN).port, ORIGIN },
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
