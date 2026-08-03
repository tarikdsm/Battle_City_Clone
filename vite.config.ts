import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Vite + Vitest share this config. Vitest is scoped to `tests/**` so it never
// picks up Playwright's `e2e/**/*.spec.ts`. The core sim runs headless (arch §2),
// so the default test environment is Node.
// `--mode pages` (used by the GitHub Pages workflow) builds with the project-site
// base path; local dev/preview/e2e keep `/`.

/**
 * The base path, resolved once and used **three** times: by Vite, by the PWA
 * manifest's `start_url`/`scope`, and by the service worker's registration URL.
 *
 * This is the whole of arch §10's deploy risk. `.github/workflows/deploy.yml`
 * builds with `--mode pages`, which serves the app from
 * `https://<user>.github.io/Battle_City_Clone/` — and a service worker's scope
 * is capped by the directory it is served from, while a manifest's `start_url`
 * is resolved against the manifest's own URL. Get any one of the three wrong and
 * the installed app opens on a 404 of the site root: a failure that cannot be
 * seen from a dev server, from a `/`-based build, or from any test that does not
 * run against the `pages` build itself.
 */
const PAGES_BASE = '/Battle_City_Clone/';

export default defineConfig(({ mode }) => {
  const base = mode === 'pages' ? PAGES_BASE : '/';
  return {
    base,
    plugins:
      // Vitest evaluates this file too (`mode === 'test'`), and the PWA plugin
      // has no business generating a service worker for a node test run.
      mode === 'test'
        ? []
        : [
            VitePWA({
              // The game makes no network calls at runtime (GDD pillar 4), so
              // there is nothing for a player to decide about an update and no
              // in-flight request one could break. A prompt UI would be a screen
              // that exists only to be dismissed.
              registerType: 'autoUpdate',
              // Emits `registerSW.js` next to the entry and a <script> for it in
              // index.html, both under `base` — which is why the registration
              // URL cannot drift from the build's base path.
              injectRegister: 'auto',
              // Explicit rather than inherited. It defaults to Vite's `base`,
              // but this is the one option whose silence would be indefensible:
              // see PAGES_BASE.
              base,
              workbox: {
                /**
                 * Arch §10: "precache app shell + **all** built assets (fonts
                 * included)". The default is js/css/html only, which would leave
                 * the two bundled woff2 faces to a network that is not there —
                 * the app would boot offline and render art §10's typography in
                 * a system fallback.
                 */
                globPatterns: [
                  '**/*.{js,css,html,woff2,png,svg,json,webmanifest}',
                ],
                /**
                 * The three.js bundle is over Workbox's 2 MiB default, and the
                 * failure is **silent**: an oversized asset is dropped from the
                 * precache manifest with a build-time warning, and the app then
                 * works offline right up until it needs the renderer.
                 */
                maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
                /**
                 * A reload of any in-app URL — `#editor`, or a link carrying a
                 * `?stage=` query — is a navigation, and offline it has to be
                 * answered by the shell rather than by the network.
                 */
                navigateFallback: `${base}index.html`,
                // The precache is the whole app; a stale copy from an older
                // build is dead weight in a cache quota a phone actually has.
                cleanupOutdatedCaches: true,
              },
              manifest: {
                name: 'Battle City',
                short_name: 'Battle City',
                description:
                  'A 3D remake of the 1985 tank game. Thirty-five original stages, twelve new ones, and a stage editor.',
                // Both resolved against the deploy root rather than assumed.
                // `scope` is what stops the installed app from navigating out of
                // the project site; `start_url` is where the icon opens.
                start_url: base,
                scope: base,
                display: 'standalone',
                background_color: '#0a0a0a',
                // Matches index.html's <meta name="theme-color">; a mismatch
                // shows as a flash of the wrong colour on launch.
                theme_color: '#0a0a0a',
                icons: [
                  {
                    src: 'icons/icon-192.png',
                    sizes: '192x192',
                    type: 'image/png',
                    purpose: 'any',
                  },
                  {
                    src: 'icons/icon-512.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'any',
                  },
                  // Android crops a maskable icon to the launcher's own shape.
                  // Without this row the mark is letterboxed into a white
                  // rounded square; with it, the safe-zone version is used.
                  {
                    src: 'icons/icon-maskable-512.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable',
                  },
                ],
              },
            }),
          ],
    server: {
      port: 5173,
      strictPort: true,
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
