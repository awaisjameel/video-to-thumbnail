import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'fluent-ffmpeg';
import { ThumbnailGenerator } from '../src/ThumbnailGenerator.js';
import { ThumbnailDownloadError, ThumbnailGenerationError } from '../src/errors.js';

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

  it('rejects a non-positive downloadTimeoutMs', (t) => {
    t.assert.throws(() => new ThumbnailGenerator({ downloadTimeoutMs: 0 }), RangeError);
    t.assert.throws(() => new ThumbnailGenerator({ downloadTimeoutMs: -1 }), RangeError);
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

  it('rejects a non-array passed to getVideoThumbnails', async (t) => {
    await t.assert.rejects(
      () => generator.getVideoThumbnails(/** @type {any} */ (fixtureVideoPath)),
      TypeError,
    );
  });

  it('fails fast with a ThumbnailGenerationError for a missing local file, without invoking ffmpeg', async (t) => {
    await t.assert.rejects(
      () => generator.getVideoThumbnail(path.join(workDir, 'does-not-exist.mp4')),
      (error) => {
        t.assert.ok(error instanceof ThumbnailGenerationError);
        t.assert.equal(error.code, 'THUMBNAIL_GENERATION_FAILED');
        t.assert.match(error.message, /not found/i);
        return true;
      },
    );
  });

  it('fails with a ThumbnailGenerationError when the local path is a directory', async (t) => {
    await t.assert.rejects(
      () => generator.getVideoThumbnail(workDir),
      (error) => {
        t.assert.ok(error instanceof ThumbnailGenerationError);
        t.assert.match(error.message, /not a regular file/i);
        return true;
      },
    );
  });

  it('writes to an exact filename when options.filename is given, with no random suffix', async (t) => {
    const thumbnailPath = await generator.getVideoThumbnail(fixtureVideoPath, { filename: 'exact.png' });
    t.assert.equal(thumbnailPath, path.join(workDir, 'thumbnails', 'exact.png'));
    await assertIsPng(thumbnailPath);
  });

  it('rejects options.filename containing a directory separator', async (t) => {
    await t.assert.rejects(
      () => generator.getVideoThumbnail(fixtureVideoPath, { filename: '../escape.png' }),
      TypeError,
    );
  });

  it('rejects options.filename without a .png extension', async (t) => {
    await t.assert.rejects(
      () => generator.getVideoThumbnail(fixtureVideoPath, { filename: 'exact.jpg' }),
      TypeError,
    );
  });

  it('resolves a percentage timestamp (requires ffprobe to read the video duration)', async (t) => {
    const thumbnailPath = await generator.getVideoThumbnail(fixtureVideoPath, {
      timestamp: '50%',
      filename: 'percentage-timestamp.png',
    });
    await assertIsPng(thumbnailPath);
  });

  it('applies a per-call size override', async (t) => {
    const thumbnailPath = await generator.getVideoThumbnail(fixtureVideoPath, {
      filename: 'resized.png',
      size: '80x?',
    });
    await assertIsPng(thumbnailPath);
  });

  it('rejects an already-aborted signal without doing any work', async (t) => {
    const controller = new AbortController();
    controller.abort();

    await t.assert.rejects(
      () => generator.getVideoThumbnail(fixtureVideoPath, { signal: controller.signal }),
      (error) => {
        t.assert.equal(error.name, 'AbortError');
        return true;
      },
    );
  });

  it('aborts an in-flight ffmpeg run via signal', async (t) => {
    const controller = new AbortController();
    const promise = generator.getVideoThumbnail(fixtureVideoPath, {
      signal: controller.signal,
      filename: 'aborted.png',
    });
    setTimeout(() => controller.abort(), 5);

    await t.assert.rejects(promise, (error) => {
      t.assert.equal(error.name, 'AbortError');
      return true;
    });
  });

  it('aborts an in-flight download via signal', async (t) => {
    t.mock.method(globalThis, 'fetch', (url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      });
    });

    const controller = new AbortController();
    const promise = generator.getVideoThumbnail('https://example.com/videos/slow.mp4', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);

    await t.assert.rejects(promise, (error) => {
      t.assert.equal(error.name, 'AbortError');
      return true;
    });
  });

  it('does not clobber an explicit ffmpegPath set by an earlier instance when a later instance uses defaults', (t) => {
    const calls = t.mock.method(ffmpeg, 'setFfmpegPath');

    new ThumbnailGenerator({
      thumbsDir: path.join(workDir, 'a'),
      tempDir: path.join(workDir, 'a-temp'),
      ffmpegPath: '/custom/ffmpeg-binary',
    });
    calls.mock.resetCalls();

    new ThumbnailGenerator({
      thumbsDir: path.join(workDir, 'b'),
      tempDir: path.join(workDir, 'b-temp'),
    });

    t.assert.equal(calls.mock.callCount(), 0);
  });

  it('does not clobber an explicit ffprobePath set by an earlier instance when a later instance uses defaults', (t) => {
    const calls = t.mock.method(ffmpeg, 'setFfprobePath');

    new ThumbnailGenerator({
      thumbsDir: path.join(workDir, 'c'),
      tempDir: path.join(workDir, 'c-temp'),
      ffprobePath: '/custom/ffprobe-binary',
    });
    calls.mock.resetCalls();

    new ThumbnailGenerator({
      thumbsDir: path.join(workDir, 'd'),
      tempDir: path.join(workDir, 'd-temp'),
    });

    t.assert.equal(calls.mock.callCount(), 0);
  });
});
