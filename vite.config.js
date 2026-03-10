import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('./public/version.json', 'utf8')).version;

export default defineConfig({
  root: '.',
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 8080,
  },
  preview: {
    port: 8080,
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,json}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // Clean up old hand-written SW caches during the transition
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/nano-gpt\.com\//,
            handler: 'NetworkOnly',
          },
        ],
      },
      manifest: false, // Use existing manifest.json from public/
      injectRegister: false, // We handle SW registration in app.js
    }),
  ],
});
