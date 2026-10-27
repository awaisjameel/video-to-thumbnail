import { afterEach, beforeEach, describe, it } from 'node:test';
import { copyFile, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    t.assert.throws(() => new ThumbnailGenerator({ downloadTimeoutMs: 1.5 }), RangeError);
    t.assert.throws(() => new ThumbnailGenerator({ downloadTimeoutMs: 2 ** 32 }), RangeError);
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
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(videoBuffer, { status: 200, statusText: 'OK' }),
    );

    const thumbnailPath = await generator.getVideoThumbnail(
      'https://example.com/videos/sample-video.mp4?sig=abc',
    );
    await assertIsPng(thumbnailPath);

    const downloadsDir = path.join(workDir, 'temp', 'downloads');
    const leftovers = await readdir(downloadsDir).catch(() => []);
    t.assert.deepEqual(leftovers, []);
  });

  it('wraps a non-2xx download response in a ThumbnailDownloadError', async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(null, { status: 404, statusText: 'Not Found' }),
    );

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
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(null, { status: 500, statusText: 'Server Error' }),
    );

    const results = await generator.getVideoThumbnails([
      fixtureVideoPath,
      'https://example.com/broken.mp4',
    ]);

    t.assert.equal(results.length, 2);
    t.assert.equal(results[0].input, fixtureVideoPath);
    t.assert.ok(results[0].thumbnailPath);
    t.assert.equal(results[1].input, 'https://example.com/broken.mp4');
    t.assert.ok(results[1].error instanceof ThumbnailDownloadError);
  });

  it('rejects a non-array passed to getVideoThumbnails', async (t) => {
    await t.assert.rejects(
      // @ts-expect-error Exercise runtime validation of an invalid argument.
      () => generator.getVideoThumbnails(fixtureVideoPath),
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
    const thumbnailPath = await generator.getVideoThumbnail(fixtureVideoPath, {
      filename: 'exact.png',
    });
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

  it('resolves a percentage timestamp (requires ffprobe to read the video duration)', async () => {
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
    const png = await readFile(thumbnailPath);
    t.assert.equal(png.readUInt32BE(16), 80);
  });

  it('detects the input format from content even when the extension is unknown', async () => {
    const video = path.join(workDir, 'media.unknown');
    await copyFile(fixtureVideoPath, video);
    await assertIsPng(await generator.getVideoThumbnail(video));
  });

  it('preserves an existing output when no frame exists at the requested timestamp', async (t) => {
    const preview = await generator.getVideoThumbnail(fixtureVideoPath, {
      filename: 'preview.png',
    });
    const original = await readFile(preview);
    await t.assert.rejects(
      generator.getVideoThumbnail(fixtureVideoPath, {
        filename: 'preview.png',
        timestamp: '10000',
      }),
      ThumbnailGenerationError,
    );
    t.assert.deepEqual(await readFile(preview), original);
    t.assert.deepEqual(await readdir(path.dirname(preview)), ['preview.png']);
  });

  it('rejects a shared batch filename', async (t) => {
    await t.assert.rejects(
      generator.getVideoThumbnails([fixtureVideoPath, fixtureVideoPath], {
        filename: 'collision.png',
      }),
      TypeError,
    );
  });

  it('rejects empty and non-portable custom filenames', async (t) => {
    for (const filename of [
      '',
      '..\\escape.png',
      'CON.png',
      'folder/file.png',
      'a<b.png',
      'a>b.png',
      'a"b.png',
      'a|b.png',
      'a?b.png',
      'a*b.png',
    ]) {
      await t.assert.rejects(
        generator.getVideoThumbnail(fixtureVideoPath, { filename }),
        TypeError,
      );
    }
  });

  it('bounds concurrent remote work across direct calls', async (t) => {
    const video = await readFile(fixtureVideoPath);
    let active = 0;
    let maximum = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response(video);
    });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        generator.getVideoThumbnail(`https://example.com/${index}.mp4`),
      ),
    );
    t.assert.equal(maximum, 2);
  });

  it('streams real HTTP downloads and cleans up timed-out response bodies', async (t) => {
    const video = await readFile(fixtureVideoPath);
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      if (request.url === '/slow') response.write(video.subarray(0, 16));
      else response.end(video);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await assertIsPng(await generator.getVideoThumbnail(`${baseUrl}/success`));
      const short = new ThumbnailGenerator({
        thumbsDir: path.join(workDir, 'short'),
        tempDir: path.join(workDir, 'short-temp'),
        downloadTimeoutMs: 100,
      });
      await t.assert.rejects(
        short.getVideoThumbnail(`${baseUrl}/slow`),
        (error) => error instanceof ThumbnailDownloadError && error.cause.name === 'TimeoutError',
      );
      t.assert.deepEqual(await readdir(short.downloadsDir), []);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
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

  it('cancels queued work promptly without waiting for the running job', async (t) => {
    const video = await readFile(fixtureVideoPath);
    let release;
    let notifyStarted;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    t.mock.method(globalThis, 'fetch', async () => {
      notifyStarted();
      await gate;
      return new Response(video);
    });
    const serial = new ThumbnailGenerator({
      concurrency: 1,
      thumbsDir: path.join(workDir, 'serial'),
      tempDir: path.join(workDir, 'serial-temp'),
    });
    const running = serial.getVideoThumbnail('https://example.com/running.mp4');
    await started;
    const controller = new AbortController();
    const reason = new Error('queued cancellation');
    const queued = serial.getVideoThumbnail(fixtureVideoPath, { signal: controller.signal });
    controller.abort(reason);
    let timer;
    try {
      await t.assert.rejects(
        Promise.race([
          queued,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('queued cancellation waited for the running job')),
              100,
            );
          }),
        ]),
        (error) => error === reason,
      );
    } finally {
      clearTimeout(timer);
      release();
      await running;
    }
  });

  it('keeps executable paths independent between generator instances', async (t) => {
    const broken = new ThumbnailGenerator({
      thumbsDir: path.join(workDir, 'broken'),
      ffmpegPath: path.join(workDir, 'missing-ffmpeg'),
      ffprobePath: path.join(workDir, 'missing-ffprobe'),
    });
    const working = new ThumbnailGenerator({ thumbsDir: path.join(workDir, 'working') });
    await t.assert.rejects(broken.getVideoThumbnail(fixtureVideoPath), ThumbnailGenerationError);
    await assertIsPng(await working.getVideoThumbnail(fixtureVideoPath));
    await t.assert.rejects(
      broken.getVideoThumbnail(fixtureVideoPath, { timestamp: '50%' }),
      ThumbnailGenerationError,
    );
    await assertIsPng(await working.getVideoThumbnail(fixtureVideoPath, { timestamp: '50%' }));
  });
});
