import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

// Chromium-only smoke suite (arch §13). The dev server is started for us.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  /**
   * **One**, not the CPU default (T6.1/T6.2).
   *
   * Every test here brings up a real WebGL context and drives a 60 Hz loop, so
   * they contend for one GPU rather than for cores — and the failure that
   * forces this is not slowness, it is *corruption*: at four workers the suite
   * produced `THREE.WebGLProgram: Shader Error … VALIDATE_STATUS false` with an
   * empty info log (26 of them in one boot), which is what a lost context looks
   * like, and the run that lost it then failed assertions that have nothing to
   * do with the thing under test. Serially the identical suite is clean.
   * Screenshots are the expensive part: one `locator.screenshot()` of the
   * canvas measures ~3.5 s even on an idle machine.
   */
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
