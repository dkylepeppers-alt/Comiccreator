# Native File Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make comic-page PNG and full-data JSON exports open Android's share sheet while retaining normal browser downloads.

**Architecture:** A focused `file-export.ts` module owns native detection and file delivery. Existing page modules continue producing their content, then call the shared exporter and provide accurate success or failure feedback.

**Tech Stack:** TypeScript, Vite, Vitest, Capacitor 8, `@capacitor/filesystem`, `@capacitor/share`, Android Gradle.

## Global Constraints

- Change only **Save Image** on the Library page and **Export All Data (JSON)** in Settings.
- Native exports write to `Directory.Cache` and open the Android share sheet.
- Browser/PWA exports retain Blob, object-URL, and download-anchor behavior.
- Do not claim that a file was downloaded or saved when native code only opened the share sheet.
- Preserve the existing `page-<number>.png` and timestamped JSON backup filename formats.
- Preserve unrelated `docs/seedream-visual-continuity-spec.md` without staging or editing it.

---

### Task 1: Shared Cross-Platform File Exporter

**Files:**
- Create: `src/js/file-export.ts`
- Create: `test/file-export.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify through Capacitor sync: `android/capacitor.settings.gradle`
- Modify through Capacitor sync: `android/app/capacitor.build.gradle`

**Interfaces:**
- Consumes: `Capacitor.isNativePlatform()`, `Filesystem.writeFile()`, `Share.share()`, browser `Blob`, `URL`, and `document` APIs.
- Produces: `exportFile(options: ExportFileOptions): Promise<'share' | 'download'>`.

- [ ] **Step 1: Install Capacitor 8 plugins**

Run:

```bash
npm --cache /tmp/npm-cache install @capacitor/filesystem@^8.1.2 @capacitor/share@^8.0.1
```

Expected: both dependencies are added under `dependencies`; the lockfile resolves versions compatible with `@capacitor/core >=8.0.0`.

- [ ] **Step 2: Write the failing shared-export tests**

Create `test/file-export.test.js` with hoisted Vitest mocks for Capacitor, Filesystem, and Share. Cover these exact behaviors:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  writeFile: vi.fn(),
  share: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: nativeMocks.isNativePlatform },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: nativeMocks.writeFile },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: nativeMocks.share } }));

import { exportFile } from '../src/js/file-export.js';

describe('exportFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    nativeMocks.isNativePlatform.mockReset();
    nativeMocks.writeFile.mockReset();
    nativeMocks.share.mockReset();
  });

  it('writes UTF-8 text to native cache and shares the returned URI', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/backup.json' });
    nativeMocks.share.mockResolvedValue({});
    await expect(exportFile({ filename: 'backup.json', mimeType: 'application/json', data: '{"ok":true}', title: 'Backup' })).resolves.toBe('share');
    expect(nativeMocks.writeFile).toHaveBeenCalledWith({ path: 'backup.json', data: '{"ok":true}', directory: 'CACHE', encoding: 'utf8' });
    expect(nativeMocks.share).toHaveBeenCalledWith({ title: 'Backup', files: ['file:///cache/backup.json'], dialogTitle: 'Share Backup' });
  });

  it('base64-encodes binary data before writing it to native cache', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/page-1.png' });
    nativeMocks.share.mockResolvedValue({});
    await exportFile({ filename: 'page-1.png', mimeType: 'image/png', data: new Blob([Uint8Array.from([0, 255, 16])]), title: 'Comic Page' });
    expect(nativeMocks.writeFile).toHaveBeenCalledWith({ path: 'page-1.png', data: 'AP8Q', directory: 'CACHE' });
  });

  it('uses an object URL and temporary download anchor in a browser', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(false);
    const click = vi.fn();
    const anchor = { href: '', download: '', click };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    await expect(exportFile({ filename: 'backup.json', mimeType: 'application/json', data: '{}' })).resolves.toBe('download');
    expect(anchor).toMatchObject({ href: 'blob:test', download: 'backup.json' });
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('rejects when native sharing fails', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/backup.json' });
    nativeMocks.share.mockRejectedValue(new Error('share failed'));
    await expect(exportFile({ filename: 'backup.json', mimeType: 'application/json', data: '{}' })).rejects.toThrow('share failed');
  });
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/file-export.test.js
```

Expected: FAIL because `src/js/file-export.ts` does not exist.

- [ ] **Step 4: Implement the minimal shared exporter**

Create `src/js/file-export.ts`:

```ts
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface ExportFileOptions {
  filename: string;
  mimeType: string;
  data: string | Blob;
  title?: string;
}

export type ExportDelivery = 'share' | 'download';

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function exportFile(options: ExportFileOptions): Promise<ExportDelivery> {
  const { filename, mimeType, data, title = filename } = options;
  if (Capacitor.isNativePlatform()) {
    const isText = typeof data === 'string';
    const result = await Filesystem.writeFile({
      path: filename,
      data: isText ? data : await blobToBase64(data),
      directory: Directory.Cache,
      ...(isText ? { encoding: Encoding.UTF8 } : {}),
    });
    await Share.share({ title, files: [result.uri], dialogTitle: `Share ${title}` });
    return 'share';
  }

  const blob = typeof data === 'string' ? new Blob([data], { type: mimeType }) : data;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return 'download';
}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run test/file-export.test.js
```

Expected: 4 tests pass.

- [ ] **Step 6: Sync the native plugins**

Run:

```bash
npx cap sync android
```

Expected: Capacitor reports `@capacitor/filesystem` and `@capacitor/share`; generated Android Gradle files register both plugins.

- [ ] **Step 7: Commit Task 1**

```bash
git add package.json package-lock.json src/js/file-export.ts test/file-export.test.js android/capacitor.settings.gradle android/app/capacitor.build.gradle
git diff --cached --check
git commit -m "feat: add native file export service"
```

### Task 2: Route Library PNG and Settings JSON Through the Exporter

**Files:**
- Create: `test/page-file-export.test.js`
- Modify: `src/js/pages/library.ts`
- Modify: `src/js/pages/settings.ts`

**Interfaces:**
- Consumes: `exportFile(options): Promise<'share' | 'download'>` from Task 1.
- Produces: `saveRenderedPageImage(blob, pageIndex)` and `saveBackupFile(data, timestamp)` for focused integration tests; the existing page actions call these functions.

- [ ] **Step 1: Write failing page-integration tests**

Create `test/page-file-export.test.js` with a mocked `exportFile`, an `App` test double, and dynamic imports of both page modules. Verify:

```js
await saveRenderedPageImage(pngBlob, 1);
expect(exportFile).toHaveBeenCalledWith({ filename: 'page-2.png', mimeType: 'image/png', data: pngBlob, title: 'Comic Page 2' });
expect(App.toast).toHaveBeenCalledWith('Share sheet opened for page image', 'success');

await saveBackupFile({ pages: [] }, 1234);
expect(exportFile).toHaveBeenCalledWith({ filename: 'comic-creator-backup-1234.json', mimeType: 'application/json', data: '{"pages":[]}', title: 'Comic Creator Backup' });
expect(App.toast).toHaveBeenCalledWith('Share sheet opened for data backup', 'success');
```

Also reject the mocked exporter once and verify the corresponding helper calls `App.logError(...)`, shows an error toast, and does not show a success toast.

- [ ] **Step 2: Run the page tests and verify RED**

Run:

```bash
npx vitest run test/page-file-export.test.js
```

Expected: FAIL because neither named integration helper exists.

- [ ] **Step 3: Implement Library delivery**

Import `exportFile` into `src/js/pages/library.ts`. Add:

```ts
export async function saveRenderedPageImage(blob: Blob, pageIdx: number): Promise<void> {
  try {
    const delivery = await exportFile({
      filename: `page-${pageIdx + 1}.png`,
      mimeType: 'image/png',
      data: blob,
      title: `Comic Page ${pageIdx + 1}`,
    });
    App.toast(delivery === 'share' ? 'Share sheet opened for page image' : 'Page image downloaded!', 'success');
  } catch (error) {
    App.logError('downloadPageImage()', error, `Page index: ${pageIdx}`);
    App.toast('Failed to export page image', 'error');
  }
}
```

Replace the existing callback-only canvas export with an awaited blob and helper call:

```ts
const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
if (!blob) return App.toast('Failed to render image', 'error');
await saveRenderedPageImage(blob, pageIdx);
```

- [ ] **Step 4: Implement Settings delivery**

Import `exportFile` into `src/js/pages/settings.ts`. Add:

```ts
export async function saveBackupFile(data: unknown, timestamp: number = Date.now()): Promise<void> {
  try {
    const delivery = await exportFile({
      filename: `comic-creator-backup-${timestamp}.json`,
      mimeType: 'application/json',
      data: JSON.stringify(data),
      title: 'Comic Creator Backup',
    });
    App.toast(delivery === 'share' ? 'Share sheet opened for data backup' : 'Data exported!', 'success');
  } catch (error) {
    logError('exportData()', error);
    App.toast('Failed to export data', 'error');
  }
}
```

Replace the current Blob/anchor block in `exportData()` with:

```ts
await saveBackupFile(data);
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run test/file-export.test.js test/page-file-export.test.js
```

Expected: all focused tests pass.

- [ ] **Step 6: Run focused static checks**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: all three commands exit 0. If Prettier reports only intended source/test files, run Prettier on those explicit files and repeat the checks.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/js/pages/library.ts src/js/pages/settings.ts test/page-file-export.test.js
git diff --cached --check
git commit -m "fix: share native image and data exports"
```

### Task 3: Full Verification and PR Handoff

**Files:**
- Verify only; modify task-related files solely if a check exposes a defect.

**Interfaces:**
- Consumes: completed native export implementation.
- Produces: verified branch suitable for PR Completion watcher.

- [ ] **Step 1: Run the complete repository validation contract**

```bash
npm test
npm run coverage
npm run lint
npm run typecheck
npm run format:check
npm run build
```

Expected: every command exits 0, coverage remains at least 60% lines and 55% branches, and Vite produces `dist/`.

- [ ] **Step 2: Verify generated native integration**

```bash
npx cap sync android
rg -n "capacitor-filesystem|capacitor-share" android/capacitor.settings.gradle android/app/capacitor.build.gradle
```

Expected: sync succeeds and both native plugins appear in generated Gradle configuration.

- [ ] **Step 3: Build the Android debug APK**

```bash
cd android
./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`. If the SDK or Java 21 is unavailable, record the exact environment error without claiming an Android build result.

- [ ] **Step 4: Re-read the design acceptance criteria and inspect the final diff**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git status --short --branch
```

Expected: only task-related committed files differ from `origin/main`; the unrelated seedream spec remains untracked and untouched.

- [ ] **Step 5: Hand the verified branch to PR Completion**

Push `agent/native-file-exports`, create a PR targeting `main`, then run the deterministic PR watcher. Repair task-caused CI or review findings autonomously. Stop at verified readiness for explicit landing confirmation, as required by the PR Completion workflow.
