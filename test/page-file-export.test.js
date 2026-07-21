import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exportMocks = vi.hoisted(() => ({
  exportFile: vi.fn(),
}));

vi.mock('../src/js/file-export.js', () => ({
  exportFile: exportMocks.exportFile,
}));

import { saveBackupFile, saveRenderedPageImage } from '../src/js/export-actions.js';

describe('page file export integrations', () => {
  const app = {
    toast: vi.fn(),
    logError: vi.fn(),
  };

  beforeEach(() => {
    exportMocks.exportFile.mockReset();
    app.toast.mockReset();
    app.logError.mockReset();
    vi.stubGlobal('App', app);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares a rendered comic page with the expected filename and MIME type', async () => {
    exportMocks.exportFile.mockResolvedValue('share');
    const pngBlob = new Blob(['png'], { type: 'image/png' });

    await saveRenderedPageImage(pngBlob, 1);

    expect(exportMocks.exportFile).toHaveBeenCalledWith({
      filename: 'page-2.png',
      mimeType: 'image/png',
      data: pngBlob,
      title: 'Comic Page 2',
    });
    expect(app.toast).toHaveBeenCalledWith('Share sheet opened for page image', 'success');
  });

  it('shares a serialized data backup with a timestamped filename', async () => {
    exportMocks.exportFile.mockResolvedValue('share');

    await saveBackupFile({ pages: [] }, 1234);

    expect(exportMocks.exportFile).toHaveBeenCalledWith({
      filename: 'comic-creator-backup-1234.json',
      mimeType: 'application/json',
      data: '{"pages":[]}',
      title: 'Comic Creator Backup',
    });
    expect(app.toast).toHaveBeenCalledWith('Share sheet opened for data backup', 'success');
  });

  it('preserves browser download success messages', async () => {
    exportMocks.exportFile.mockResolvedValue('download');

    await saveRenderedPageImage(new Blob(['png'], { type: 'image/png' }), 0);
    await saveBackupFile({ pages: [] }, 1234);

    expect(app.toast).toHaveBeenNthCalledWith(1, 'Page image downloaded!', 'success');
    expect(app.toast).toHaveBeenNthCalledWith(2, 'Data exported!', 'success');
  });

  it('logs page-image delivery failures and shows only an error toast', async () => {
    const error = new Error('share failed');
    exportMocks.exportFile.mockRejectedValue(error);

    await saveRenderedPageImage(new Blob(['png'], { type: 'image/png' }), 2);

    expect(app.logError).toHaveBeenCalledWith('downloadPageImage()', error, 'Page index: 2');
    expect(app.toast).toHaveBeenCalledOnce();
    expect(app.toast).toHaveBeenCalledWith('Failed to export page image', 'error');
  });

  it('logs backup delivery failures and shows only an error toast', async () => {
    const error = new Error('write failed');
    exportMocks.exportFile.mockRejectedValue(error);

    await saveBackupFile({ pages: [] }, 1234);

    expect(app.logError).toHaveBeenCalledWith('exportData()', error, undefined);
    expect(app.toast).toHaveBeenCalledOnce();
    expect(app.toast).toHaveBeenCalledWith('Failed to export data', 'error');
  });
});
