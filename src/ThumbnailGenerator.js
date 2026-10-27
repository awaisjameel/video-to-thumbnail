import path from 'node:path';
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import pLimit from 'p-limit';
import { parseTimestamp, resolveTimestamp, runMediaTool, scaleFilter } from './media.js';
import { ThumbnailDownloadError, ThumbnailGenerationError } from './errors.js';
import {
  baseNameFromUrl,
  extensionFromUrl,
  isHttpUrl,
  sanitizeBaseName,
  uniqueSuffix,
} from './paths.js';

/** @typedef {{ input: string, thumbnailPath: string, error?: undefined }} ThumbnailSuccess */
/** @typedef {{ input: string, thumbnailPath?: undefined, error: unknown }} ThumbnailFailure */
/**
 * @typedef {object} GenerateOptions
 * @property {string} [timestamp] ffmpeg timemark (seconds, or `"50%"`-style percentage) to capture the frame from. Overrides the instance default for this call only.
 * @property {string} [size] ffmpeg size spec for the output frame, e.g. `"320x240"`, `"320x?"` (preserve aspect ratio), or `"50%"`. Overrides the instance default for this call only.
 * @property {string} [filename] Exact output filename (e.g. `"clip.png"`), written directly under `thumbsDir` with no random suffix. Must be a bare filename (no directory separators) ending in `.png`. Omit to get a collision-free auto-generated name.
 * @property {AbortSignal} [signal] Aborts the download and/or ffmpeg process for this call. On abort, the returned promise rejects with the signal's abort reason (typically a `DOMException` named `"AbortError"`), not a `ThumbnailError`.
 */

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMESTAMP = '1';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Generates PNG thumbnails from local video files or remote video URLs
 * using ffmpeg. All calls made through a single instance share a
 * concurrency limiter, so you can safely fan out over many videos at once
 * without spawning unbounded ffmpeg processes or downloads.
 */
export class ThumbnailGenerator {
  /** @type {ReturnType<typeof pLimit>} */
  #limit;

  /** @type {Map<string, Promise<void>>} */
  #dirReady = new Map();

  /**
   * @param {object} [options]
   * @param {string} [options.thumbsDir] Directory thumbnails are written to. Created if missing. Default: `"thumbnails"` (relative to `process.cwd()`).
   * @param {string} [options.tempDir] Directory used to stage downloaded videos before they're processed. Created and cleaned up automatically. Default: `"temp"` (relative to `process.cwd()`).
   * @param {number} [options.concurrency] Maximum number of thumbnails generated at once by this instance. Default: `5`.
   * @param {string} [options.timestamp] Default ffmpeg timemark (seconds, or `"50%"`-style percentage) to capture the frame from. Default: `"1"`. Overridable per call.
   * @param {string} [options.size] Default ffmpeg size spec for the output frame (e.g. `"320x240"`). Default: source resolution. Overridable per call.
   * @param {number} [options.downloadTimeoutMs] Abort downloads that take longer than this. Default: `30000`.
   * @param {string} [options.ffmpegPath] Path to an ffmpeg executable. Default: `ffmpeg` on PATH. This setting is per instance.
   * @param {string} [options.ffprobePath] Path to an ffprobe executable, needed for percentage timestamps. Default: `ffprobe` on PATH. This setting is per instance.
   */
  constructor(options = {}) {
    const {
      thumbsDir = 'thumbnails',
      tempDir = 'temp',
      concurrency = DEFAULT_CONCURRENCY,
      timestamp = DEFAULT_TIMESTAMP,
      size,
      downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
      ffmpegPath,
      ffprobePath,
    } = options;

    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError('options.concurrency must be a positive integer');
    }
    if (
      !Number.isSafeInteger(downloadTimeoutMs) ||
      downloadTimeoutMs <= 0 ||
      downloadTimeoutMs > 4_294_967_295
    ) {
      throw new RangeError(
        'options.downloadTimeoutMs must be a positive integer no greater than 4294967295',
      );
    }
    parseTimestamp(timestamp);
    scaleFilter(size);
    if (
      (ffmpegPath !== undefined && (typeof ffmpegPath !== 'string' || !ffmpegPath.trim())) ||
      (ffprobePath !== undefined && (typeof ffprobePath !== 'string' || !ffprobePath.trim()))
    ) {
      throw new TypeError('Executable paths must be non-empty strings');
    }

    this.thumbsDir = path.resolve(thumbsDir);
    this.downloadsDir = path.resolve(tempDir, 'downloads');
    this.timestamp = timestamp;
    this.size = size;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this.ffmpegPath = ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = ffprobePath ?? 'ffprobe';

    this.#limit = pLimit(concurrency);
  }

  /**
   * Generates a thumbnail for a single local file path or `http(s)` URL,
   * queued behind this instance's concurrency limit.
   * @param {string} videoPathOrUrl
   * @param {GenerateOptions} [options]
   * @returns {Promise<string>} Absolute filesystem path to the generated PNG.
   */
  async getVideoThumbnail(videoPathOrUrl, options = {}) {
    const { signal } = options;
    signal?.throwIfAborted();
    let started = false;
    const work = this.#limit(() => {
      started = true;
      return this.#generateFromInput(videoPathOrUrl, options);
    });
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (!started) {
          cleanup();
          reject(signal.reason);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  /**
   * Generates thumbnails for many videos, respecting this instance's
   * concurrency limit. Unlike {@link getVideoThumbnail}, failures for
   * individual inputs don't reject the whole batch — each result reports
   * either a `thumbnailPath` or an `error`.
   *
   * `options` (if given) is applied to every item, so `signal` cancels the
   * whole batch and `timestamp`/`size` override the instance default for
   * the whole batch. Don't pass `filename` here — every item would collide
   * on the same output path; use {@link getVideoThumbnail} directly (e.g.
   * via `Promise.all`, which still respects the same concurrency limit) if
   * you need distinct filenames per input.
   * @param {readonly string[]} videoPathsOrUrls
   * @param {GenerateOptions} [options]
   * @returns {Promise<Array<ThumbnailSuccess | ThumbnailFailure>>}
   */
  async getVideoThumbnails(videoPathsOrUrls, options = {}) {
    if (!Array.isArray(videoPathsOrUrls)) {
      throw new TypeError('videoPathsOrUrls must be an array of strings');
    }
    if (options.filename !== undefined && videoPathsOrUrls.length > 1) {
      throw new TypeError(
        'A batch cannot share one output filename; use distinct per-call filenames',
      );
    }

    const settled = await Promise.allSettled(
      videoPathsOrUrls.map((videoPathOrUrl) => this.getVideoThumbnail(videoPathOrUrl, options)),
    );

    return settled.map((result, index) => {
      const input = videoPathsOrUrls[index];
      return result.status === 'fulfilled'
        ? { input, thumbnailPath: result.value }
        : { input, error: result.reason };
    });
  }

  /**
   * @param {string} videoPathOrUrl
   * @param {GenerateOptions} options
   * @returns {Promise<string>}
   */
  async #generateFromInput(videoPathOrUrl, options) {
    if (typeof videoPathOrUrl !== 'string' || videoPathOrUrl.length === 0) {
      throw new TypeError('videoPathOrUrl must be a non-empty string');
    }

    const { signal } = options;
    signal?.throwIfAborted();

    if (!isHttpUrl(videoPathOrUrl)) {
      await this.#assertLocalFileExists(videoPathOrUrl);
      return this.#generateThumbnail(videoPathOrUrl, options);
    }

    const { tempVideoPath, downloadDir } = await this.#downloadToTempFile(videoPathOrUrl, signal);
    try {
      return await this.#generateThumbnail(tempVideoPath, options);
    } finally {
      await this.#removeTemporaryDirectory(downloadDir, this.downloadsDir, 'dl-');
    }
  }

  /**
   * Fails fast with a clear, typed error (instead of a spawned-then-failed
   * ffmpeg process) when a local input path doesn't exist or isn't a file.
   * @param {string} videoLocalPath
   * @returns {Promise<void>}
   */
  async #assertLocalFileExists(videoLocalPath) {
    let info;
    try {
      info = await stat(videoLocalPath);
    } catch (cause) {
      throw new ThumbnailGenerationError(`Video file not found at ${videoLocalPath}`, { cause });
    }
    if (!info.isFile()) {
      throw new ThumbnailGenerationError(
        `Expected a video file at ${videoLocalPath}, but it is not a regular file`,
      );
    }
  }

  /**
   * Downloads `videoUrl` into a uniquely-named temp directory so concurrent
   * downloads of same-named files never collide.
   * @param {string} videoUrl
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ tempVideoPath: string, downloadDir: string }>}
   */
  async #downloadToTempFile(videoUrl, signal) {
    await this.#ensureDir(this.downloadsDir);
    const downloadDir = await mkdtemp(path.join(this.downloadsDir, 'dl-'));
    /** @type {AbortSignal | undefined} */
    let timeoutSignal;
    let saving = false;
    try {
      const ext = extensionFromUrl(videoUrl);
      const baseName = sanitizeBaseName(baseNameFromUrl(videoUrl));
      const tempVideoPath = path.join(downloadDir, ext ? `${baseName}.${ext}` : baseName);
      timeoutSignal = AbortSignal.timeout(this.downloadTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
      const response = await fetch(videoUrl, { signal: combinedSignal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ThumbnailDownloadError(
          `Failed to download video from ${videoUrl}: HTTP ${response.status} ${response.statusText}`,
        );
      }
      saving = true;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempVideoPath), {
        signal: combinedSignal,
      });
      return { tempVideoPath, downloadDir };
    } catch (cause) {
      await this.#removeTemporaryDirectory(downloadDir, this.downloadsDir, 'dl-');
      if (signal?.aborted) throw signal.reason;
      if (cause instanceof ThumbnailDownloadError) throw cause;
      throw new ThumbnailDownloadError(
        timeoutSignal?.aborted
          ? `Timed out after ${this.downloadTimeoutMs}ms downloading video from ${videoUrl}`
          : `Failed to ${saving ? 'save downloaded' : 'fetch'} video from ${videoUrl}`,
        { cause: timeoutSignal?.aborted ? timeoutSignal.reason : cause },
      );
    }
  }

  /**
   * @param {string} directory
   * @param {string} parent
   * @param {string} prefix
   */
  async #removeTemporaryDirectory(directory, parent, prefix) {
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(prefix)) {
      throw new Error('Refusing to remove a directory outside its temporary parent');
    }
    await rm(directory, { recursive: true, force: true });
  }
  /**
   * Extracts a single frame from `videoLocalPath` and writes it as a PNG
   * into {@link thumbsDir}.
   * @param {string} videoLocalPath
   * @param {GenerateOptions} options
   * @returns {Promise<string>}
   */
  async #generateThumbnail(videoLocalPath, options) {
    const { signal, timestamp = this.timestamp, size = this.size, filename } = options;
    signal?.throwIfAborted();
    parseTimestamp(timestamp);
    const filter = scaleFilter(size);
    const thumbnailFilename =
      filename !== undefined
        ? this.#validateCustomFilename(filename)
        : `${sanitizeBaseName(path.basename(videoLocalPath, path.extname(videoLocalPath)))}-${uniqueSuffix()}.png`;
    await this.#ensureDir(this.thumbsDir);
    const stagingDir = await mkdtemp(path.join(this.thumbsDir, '.thumb-'));
    const temporaryOutput = path.join(stagingDir, 'frame.png');
    const thumbnailPath = path.join(this.thumbsDir, thumbnailFilename);
    try {
      const seconds = await resolveTimestamp(
        timestamp,
        path.resolve(videoLocalPath),
        this.ffprobePath,
        signal,
      );
      await runMediaTool(
        this.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-ss',
          String(seconds),
          '-i',
          path.resolve(videoLocalPath),
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-an',
          '-sn',
          '-dn',
          ...(filter ? ['-vf', filter] : []),
          '-c:v',
          'png',
          '-threads',
          '1',
          '-f',
          'image2',
          '-update',
          '1',
          temporaryOutput,
        ],
        signal,
      );
      const handle = await open(temporaryOutput, 'r');
      try {
        const header = Buffer.alloc(8);
        const { bytesRead } = await handle.read(header, 0, 8, 0);
        if (bytesRead !== 8 || !header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error('FFmpeg did not produce a PNG frame at the requested timestamp');
        }
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      await rename(temporaryOutput, thumbnailPath);
      return thumbnailPath;
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw new ThumbnailGenerationError(
        `Failed to generate thumbnail for ${videoLocalPath}. Ensure FFmpeg/FFprobe are installed or configure their executable paths.`,
        { cause },
      );
    } finally {
      await this.#removeTemporaryDirectory(stagingDir, this.thumbsDir, '.thumb-');
    }
  }
  /**
   * @param {string} filename
   * @returns {string}
   */
  #validateCustomFilename(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('options.filename must be a non-empty string');
    }
    if (
      path.basename(filename) !== filename ||
      // Control characters and reserved punctuation are invalid in portable filenames.
      // oxlint-disable-next-line no-control-regex
      /[\\/:<>"|?*\x00-\x1f]/.test(filename) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename)
    ) {
      throw new TypeError(
        'options.filename must be a bare filename, not a path (no directory separators)',
      );
    }
    if (path.extname(filename).toLowerCase() !== '.png') {
      throw new TypeError('options.filename must end with ".png"');
    }
    return filename;
  }

  /**
   * Ensures `dir` exists, memoizing the in-flight/completed check per
   * directory so hot paths (e.g. batch generation) don't re-issue a
   * redundant `mkdir` syscall for every single call. Failures aren't
   * cached, so a transient error (e.g. a permissions issue) can be
   * retried by a later call instead of poisoning the instance forever.
   * @param {string} dir
   * @returns {Promise<void>}
   */
  async #ensureDir(dir) {
    let ready = this.#dirReady.get(dir);
    if (!ready) {
      ready = mkdir(dir, { recursive: true })
        .then(() => undefined)
        .catch((error) => {
          this.#dirReady.delete(dir);
          throw error;
        });
      this.#dirReady.set(dir, ready);
    }
    return ready;
  }
}
