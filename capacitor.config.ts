import type { CapacitorConfig } from '@capacitor/cli';

// NOTE: CapacitorHttp must stay disabled — the app streams chat completions
// via fetch (src/js/api.ts), and the NanoGPT API allows all origins via CORS.
const config: CapacitorConfig = {
  appId: 'com.dkylepeppers.comiccreator',
  appName: 'AI Comic Creator',
  webDir: 'dist',
};

export default config;
