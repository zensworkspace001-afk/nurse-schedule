import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
// E2E_BASE_URL：直接測已部署的站（例如 CI 用 docker compose 起的地端版 https://localhost:8443），不啟動 dev server
const DEPLOYED_URL = process.env.E2E_BASE_URL;
const BASE_URL = DEPLOYED_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // CI 的地端部署用自簽憑證
    ignoreHTTPSErrors: !!DEPLOYED_URL,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: DEPLOYED_URL ? undefined : {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
