import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);

function read(file) {
  return readFileSync(new URL(file, root), 'utf8');
}

describe('configuration integrity', () => {
  it('version sync across version.json, package.json, and index.html footer', () => {
    const version = JSON.parse(read('public/version.json')).version;
    const index = read('index.html');
    assert.ok(index.includes(`v${version} &middot; PWA`), `index.html footer must contain v${version}`);
  });

  it('package.json version matches version.json', () => {
    const version = JSON.parse(read('public/version.json')).version;
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.version, version, `package.json version "${pkg.version}" must match version.json "${version}"`);
  });
});
