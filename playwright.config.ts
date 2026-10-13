import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    colorScheme: 'dark',
  },
  projects: [
    { name: 'app', testIgnore: /pwa\.spec/ },
    // the service worker only exists in the production build
    { name: 'pwa', testMatch: /pwa\.spec/, use: { baseURL: 'http://localhost:4173' } },
  ],
  webServer: [
    {
      command: 'bun run dev',
      port: 5173,
      reuseExistingServer: true,
      env: {
        // deterministic offline testing: mqtt strategy only, local broker
        VITE_STRATEGIES: 'mqtt',
        VITE_LOCAL_BROKER: '1',
      },
    },
    {
      command: 'bunx vite build --outDir dist-e2e && bunx vite preview --outDir dist-e2e --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: true,
      env: { VITE_STRATEGIES: 'mqtt', VITE_LOCAL_BROKER: '1' },
    },
  ],
})
