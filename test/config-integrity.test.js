import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);

function read(file) {
  return readFileSync(new URL(file, root), 'utf8');
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
});
