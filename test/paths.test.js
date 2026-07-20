import { describe, it } from 'node:test';
import {
  baseNameFromUrl,
  extensionFromPath,
  extensionFromUrl,
  isHttpUrl,
  sanitizeBaseName,
  uniqueSuffix,
} from '../src/paths.js';

describe('isHttpUrl', () => {
  it('accepts http and https URLs', (t) => {
    t.assert.equal(isHttpUrl('http://example.com/video.mp4'), true);
    t.assert.equal(isHttpUrl('https://example.com/video.mp4?token=abc'), true);
  });

  it('rejects local paths and non-http protocols', (t) => {
    t.assert.equal(isHttpUrl('./videos/clip.mp4'), false);
    t.assert.equal(isHttpUrl('/absolute/path/clip.mp4'), false);
    t.assert.equal(isHttpUrl('C:\\videos\\clip.mp4'), false);
    t.assert.equal(isHttpUrl('ftp://example.com/clip.mp4'), false);
  });

  it('rejects non-string input without throwing', (t) => {
    t.assert.equal(isHttpUrl(/** @type {any} */ (null)), false);
    t.assert.equal(isHttpUrl(/** @type {any} */ (undefined)), false);
  });
});

describe('extensionFromUrl', () => {
  it('ignores query strings and fragments', (t) => {
    t.assert.equal(extensionFromUrl('https://cdn.example.com/videos/clip.mp4?sig=xyz&exp=123'), 'mp4');
    t.assert.equal(extensionFromUrl('https://cdn.example.com/videos/clip.MOV#t=10'), 'mov');
  });

  it('returns an empty string when there is no extension', (t) => {
    t.assert.equal(extensionFromUrl('https://cdn.example.com/videos/clip'), '');
  });
});

describe('extensionFromPath', () => {
  it('lowercases the extension', (t) => {
    t.assert.equal(extensionFromPath('/local/videos/clip.MP4'), 'mp4');
  });
});

describe('baseNameFromUrl', () => {
  it('extracts the filename without extension', (t) => {
    t.assert.equal(baseNameFromUrl('https://cdn.example.com/videos/my-clip.mp4?sig=xyz'), 'my-clip');
  });
});

describe('sanitizeBaseName', () => {
  it('strips unsafe characters and collapses them', (t) => {
    t.assert.equal(sanitizeBaseName('my clip (final)!!.mp4'), 'my-clip-final-.mp4');
  });

  it('falls back to a default when nothing safe remains', (t) => {
    t.assert.equal(sanitizeBaseName('???'), 'video');
  });

  it('truncates very long names', (t) => {
    t.assert.equal(sanitizeBaseName('a'.repeat(500)).length, 100);
  });
});

describe('uniqueSuffix', () => {
  it('produces distinct short identifiers', (t) => {
    const a = uniqueSuffix();
    const b = uniqueSuffix();
    t.assert.equal(a.length, 8);
    t.assert.notEqual(a, b);
  });
});
