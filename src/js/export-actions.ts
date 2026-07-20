import { exportFile } from './file-export.js';

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
    App.logError('exportData()', error, undefined);
    App.toast('Failed to export data', 'error');
  }
}
