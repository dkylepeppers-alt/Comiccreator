/**
 * Global type declarations for the AI Comic Creator app.
 * Covers window globals set by app.ts and Vite build-time defines.
 */

/** Vite build-time define — injected by vite.config.js from public/version.json */
declare const __APP_VERSION__: string;

/** App global exposed on window by app.ts for HTML onclick handlers */
declare const App: {
  navigate(page: string, param?: string | null): Promise<void>;
  refreshPage(): void;
  getCurrentPage(): string;
  setGenIndicator(visible: boolean): void;
  showModal(html: string): void;
  hideModal(): void;
  toast(message: string, type?: string, options?: any): void;
  logError(context: string, error: any, extraDetails?: string): void;
  logWarn(context: string, message: string, extraDetails?: string): void;
  logDebug(context: string, message: string, extraDetails?: string): void;
  toggleErrorPanel(): void;
  copyErrorLog(): void;
  clearErrorLog(): void;
  getErrorLog(): any[];
};

/** Page modules exposed on window by app.ts for HTML onclick handlers */
declare const HomePage: any;
declare const CharactersPage: any;
declare const WorldsPage: any;
declare const CreatePage: any;
declare const LibraryPage: any;
declare const PresetsPage: any;
declare const ImagePresetsPage: any;
declare const SettingsPage: any;

/** Extend globalThis to include App for module-scoped references */
declare namespace globalThis {
  var App: typeof App;
}

/** Extend Window to include app globals set by app.ts */
interface Window {
  App: typeof App;
  HomePage: any;
  CharactersPage: any;
  WorldsPage: any;
  CreatePage: any;
  LibraryPage: any;
  PresetsPage: any;
  ImagePresetsPage: any;
  SettingsPage: any;
}
