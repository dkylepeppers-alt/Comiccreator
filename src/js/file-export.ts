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

    await Share.share({
      title,
      files: [result.uri],
      dialogTitle: `Share ${title}`,
    });
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
