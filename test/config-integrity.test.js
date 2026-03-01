const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

describe('configuration integrity', () => {
  it('all local script assets in index.html are present in sw.js STATIC_ASSETS', () => {
    const index = read('index.html');
    const sw = read('sw.js');
    const scripts = [...index.matchAll(/<script src="([^"]+)"/g)]
      .map(m => `/${m[1]}`)
      .filter(src => !src.startsWith('/http'));
    for (const src of scripts) {
      assert.ok(sw.includes(`'${src}'`), `missing in STATIC_ASSETS: ${src}`);
    }
  });

  it('service worker references required shell assets', () => {
    const sw = read('sw.js');
    for (const file of ['/index.html', '/css/app.css', '/version.json', '/manifest.json']) {
      assert.ok(sw.includes(`'${file}'`), `expected ${file} in STATIC_ASSETS`);
    }
  });

  it('version sync across version.json, settings.js, sw.js, and index footer', () => {
    const version = JSON.parse(read('version.json')).version;
    const settings = read('js/pages/settings.js');
    const sw = read('sw.js');
    const index = read('index.html');
    assert.ok(settings.includes(`const APP_VERSION = '${version}'`));
    assert.ok(sw.includes(`const CACHE_NAME = 'comic-creator-v${version}'`));
    assert.ok(index.includes(`v${version} &middot; PWA`));
  });

  it('package.json version matches version.json', () => {
    const version = JSON.parse(read('version.json')).version;
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.version, version, `package.json version "${pkg.version}" must match version.json "${version}"`);
  });
});
