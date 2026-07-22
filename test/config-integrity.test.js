import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url);

function read(file) {
  return readFileSync(new URL(file, root), 'utf8');
}

function sourceFilesContaining(pattern, dir = 'src/js') {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesContaining(pattern, item);
    if (!/\.[jt]s$/.test(entry.name)) return [];
    if (item.endsWith('references/legacy-migration.ts') || item.endsWith('settings/backup-import.ts')) return [];
    return read(item).includes(pattern) ? [item] : [];
  });
}

describe('configuration integrity', () => {
  it('version sync across version.json, package.json, and index.html footer', () => {
    const version = JSON.parse(read('public/version.json')).version;
    const index = read('index.html');
    expect(index.includes(`v${version} &middot; PWA`)).toBeTruthy();
  });

  it('package.json version matches version.json', () => {
    const version = JSON.parse(read('public/version.json')).version;
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.version).toBe(version);
  });

  it('contains no legacy reference runtime symbols', () => {
    const forbidden = [
      'charRefMode',
      'embeddingText',
      'buildImageEmbeddingText',
      'referenceKey',
      'locationKey',
      'referenceClassifications',
    ];
    for (const symbol of forbidden) expect(sourceFilesContaining(symbol), symbol).toEqual([]);
  });
});
