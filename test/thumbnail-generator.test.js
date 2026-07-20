import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThumbnailGenerator } from '../src/ThumbnailGenerator.js';
import { ThumbnailDownloadError } from '../src/errors.js';

const fixtureVideoPath = fileURLToPath(new URL('./fixtures/sample-video.mp4', import.meta.url));

const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** @param {string} filePath */
async function assertIsPng(filePath) {
  const info = await stat(filePath);
  if (info.size === 0) throw new Error(`expected ${filePath} to be non-empty`);

  const header = Buffer.alloc(4);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(header, 0, 4, 0);
  } finally {
    await handle.close();
  }
  if (!header.equals(PNG_MAGIC_BYTES)) {
    throw new Error(`expected ${filePath} to be a PNG file`);
  }
}

describe('ThumbnailGenerator', () => {
  /** @type {string} */
  let workDir;
  /** @type {ThumbnailGenerator} */
  let generator;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'video-to-thumbnail-test-'));
    generator = new ThumbnailGenerator({
      thumbsDir: path.join(workDir, 'thumbnails'),
      tempDir: path.join(workDir, 'temp'),
      concurrency: 2,
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects a non-positive-integer concurrency', (t) => {
    t.assert.throws(() => new ThumbnailGenerator({ concurrency: 0 }), RangeError);
    t.assert.throws(() => new ThumbnailGenerator({ concurrency: 1.5 }), RangeError);
  });

  it('generates a PNG thumbnail from a local video file', async (t) => {
    const thumbnailPath = await generator.getVideoThumbnail(fixtureVideoPath);
    t.assert.equal(path.dirname(thumbnailPath), path.join(workDir, 'thumbnails'));
    await assertIsPng(thumbnailPath);
  });

  it('generates distinct filenames for concurrent thumbnails of the same input', async (t) => {
    const [first, second] = await Promise.all([
      generator.getVideoThumbnail(fixtureVideoPath),
      generator.getVideoThumbnail(fixtureVideoPath),
    ]);
    t.assert.notEqual(first, second);
    await assertIsPng(first);
    await assertIsPng(second);
  });

  it('downloads a remote URL, generates a thumbnail, and cleans up the temp download', async (t) => {
    const videoBuffer = await readFile(fixtureVideoPath);
    t.mock.method(globalThis, 'fetch', async () => new Response(videoBuffer, { status: 200, statusText: 'OK' }));

    const thumbnailPath = await generator.getVideoThumbnail('https://example.com/videos/sample-video.mp4?sig=abc');
    await assertIsPng(thumbnailPath);

    const downloadsDir = path.join(workDir, 'temp', 'downloads');
    const leftovers = await readdir(downloadsDir).catch(() => []);
    t.assert.deepEqual(leftovers, []);
  });

  it('wraps a non-2xx download response in a ThumbnailDownloadError', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404, statusText: 'Not Found' }));

    await t.assert.rejects(
      () => generator.getVideoThumbnail('https://example.com/videos/missing.mp4'),
      (error) => {
        t.assert.ok(error instanceof ThumbnailDownloadError);
        t.assert.equal(error.code, 'THUMBNAIL_DOWNLOAD_FAILED');
        t.assert.match(error.message, /404/);
        return true;
      },
    );
  });

  it('wraps a network failure in a ThumbnailDownloadError with the original error as cause', async (t) => {
    const networkError = new Error('getaddrinfo ENOTFOUND example.invalid');
    t.mock.method(globalThis, 'fetch', async () => {
      throw networkError;
    });

    await t.assert.rejects(
      () => generator.getVideoThumbnail('https://example.invalid/video.mp4'),
      (error) => {
        t.assert.ok(error instanceof ThumbnailDownloadError);
        t.assert.equal(error.cause, networkError);
        return true;
      },
    );
  });

  it('getVideoThumbnails is fault-tolerant across a mixed batch', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500, statusText: 'Server Error' }));

    const results = await generator.getVideoThumbnails([fixtureVideoPath, 'https://example.com/broken.mp4']);

    t.assert.equal(results.length, 2);
    t.assert.equal(results[0].input, fixtureVideoPath);
    t.assert.ok(results[0].thumbnailPath);
    t.assert.equal(results[1].input, 'https://example.com/broken.mp4');
    t.assert.ok(results[1].error instanceof ThumbnailDownloadError);
  });
});
