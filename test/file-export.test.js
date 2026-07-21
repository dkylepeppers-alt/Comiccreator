import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@capacitor/share', () => ({
  Share: { share: nativeMocks.share },
}));

import { exportFile } from '../src/js/file-export.js';

describe('exportFile', () => {
  beforeEach(() => {
    nativeMocks.isNativePlatform.mockReset();
    nativeMocks.writeFile.mockReset();
    nativeMocks.share.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes UTF-8 text to native cache and shares the returned URI', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/backup.json' });
    nativeMocks.share.mockResolvedValue({});

    await expect(
      exportFile({ filename: 'backup.json', mimeType: 'application/json', data: '{"ok":true}', title: 'Backup' }),
    ).resolves.toBe('share');

    expect(nativeMocks.writeFile).toHaveBeenCalledWith({
      path: 'backup.json',
      data: '{"ok":true}',
      directory: 'CACHE',
      encoding: 'utf8',
    });
    expect(nativeMocks.share).toHaveBeenCalledWith({
      title: 'Backup',
      files: ['file:///cache/backup.json'],
      dialogTitle: 'Share Backup',
    });
  });

  it('base64-encodes binary data before writing it to native cache', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/page-1.png' });
    nativeMocks.share.mockResolvedValue({});

    await exportFile({
      filename: 'page-1.png',
      mimeType: 'image/png',
      data: new Blob([Uint8Array.from([0, 255, 16])]),
      title: 'Comic Page',
    });

    expect(nativeMocks.writeFile).toHaveBeenCalledWith({
      path: 'page-1.png',
      data: 'AP8Q',
      directory: 'CACHE',
    });
  });

  it('uses an object URL and temporary download anchor in a browser', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(false);
    const click = vi.fn();
    const anchor = { href: '', download: '', click };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    await expect(exportFile({ filename: 'backup.json', mimeType: 'application/json', data: '{}' })).resolves.toBe(
      'download',
    );

    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/json' }));
    expect(anchor).toMatchObject({ href: 'blob:test', download: 'backup.json' });
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('rejects when native sharing fails', async () => {
    nativeMocks.isNativePlatform.mockReturnValue(true);
    nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/backup.json' });
    nativeMocks.share.mockRejectedValue(new Error('share failed'));

    await expect(exportFile({ filename: 'backup.json', mimeType: 'application/json', data: '{}' })).rejects.toThrow(
      'share failed',
    );
  });
});
