import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:5000' },
  webServer: {
    command: process.env.E2E_START || "flask run --host=0.0.0.0 --port=5000",
    url: 'http://localhost:5000',
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
});
