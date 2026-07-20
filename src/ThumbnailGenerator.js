import path from 'node:path';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import ffmpeg from 'fluent-ffmpeg';
import { path as bundledFfmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as bundledFfprobePath } from '@ffprobe-installer/ffprobe';
import pLimit from 'p-limit';
import { ThumbnailDownloadError, ThumbnailGenerationError } from './errors.js';
import {
  baseNameFromUrl,
  extensionFromPath,
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
   * @param {string} [options.ffmpegPath] Path to an ffmpeg binary. Defaults to the one bundled via `@ffmpeg-installer/ffmpeg`.
   *   Note: fluent-ffmpeg caches this path at the module level, so setting it applies process-wide. To limit the blast
   *   radius, this constructor only touches that global path when it's the first `ThumbnailGenerator` created in the
   *   process, or when `ffmpegPath` is explicitly passed — plain default instances created afterward never clobber an
   *   explicit choice made by an earlier instance. Two *different* explicit `ffmpegPath` values in the same process
   *   still conflict (last one wins for everybody); run those in separate processes/workers if you need both.
   * @param {string} [options.ffprobePath] Path to an ffprobe binary, used only to resolve percentage-style `timestamp`
   *   values (e.g. `"50%"`) to an absolute time. Defaults to the one bundled via `@ffprobe-installer/ffprobe`. Subject
   *   to the same process-wide caching behavior, and the same mitigation, as `ffmpegPath`.
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

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('options.concurrency must be a positive integer');
    }
    if (!Number.isFinite(downloadTimeoutMs) || downloadTimeoutMs <= 0) {
      throw new RangeError('options.downloadTimeoutMs must be a positive number');
    }

    this.thumbsDir = path.resolve(thumbsDir);
    this.downloadsDir = path.resolve(tempDir, 'downloads');
    this.timestamp = timestamp;
    this.size = size;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this.ffmpegPath = ffmpegPath ?? bundledFfmpegPath;
    this.ffprobePath = ffprobePath ?? bundledFfprobePath;

    this.#limit = pLimit(concurrency);

    // fluent-ffmpeg has no per-instance concept of the ffmpeg/ffprobe binary paths (see the
    // doc comments above): it caches whatever's passed in shared, process-global state. We
    // only mutate that global when this instance explicitly asked for a specific binary, or
    // when nothing has configured it yet, so later default-option instances never silently
    // override an earlier instance's explicit choice.
    if (ffmpegPath !== undefined || !ThumbnailGenerator.#ffmpegPathConfigured) {
      ffmpeg.setFfmpegPath(this.ffmpegPath);
      ThumbnailGenerator.#ffmpegPathConfigured = true;
    }
    if (ffprobePath !== undefined || !ThumbnailGenerator.#ffprobePathConfigured) {
      ffmpeg.setFfprobePath(this.ffprobePath);
      ThumbnailGenerator.#ffprobePathConfigured = true;
    }
  }

  static #ffmpegPathConfigured = false;
  static #ffprobePathConfigured = false;

  /**
   * Generates a thumbnail for a single local file path or `http(s)` URL,
   * queued behind this instance's concurrency limit.
   * @param {string} videoPathOrUrl
   * @param {GenerateOptions} [options]
   * @returns {Promise<string>} Absolute filesystem path to the generated PNG.
   */
  async getVideoThumbnail(videoPathOrUrl, options = {}) {
    options.signal?.throwIfAborted();
    return this.#limit(() => this.#generateFromInput(videoPathOrUrl, options));
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
      await rm(downloadDir, { recursive: true, force: true });
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
      throw new ThumbnailGenerationError(`Expected a video file at ${videoLocalPath}, but it is not a regular file`);
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

    const ext = extensionFromUrl(videoUrl);
    const baseName = sanitizeBaseName(baseNameFromUrl(videoUrl));
    const tempVideoPath = path.join(downloadDir, ext ? `${baseName}.${ext}` : baseName);

    const timeoutSignal = AbortSignal.timeout(this.downloadTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response;
    try {
      response = await fetch(videoUrl, { signal: combinedSignal });
    } catch (cause) {
      await rm(downloadDir, { recursive: true, force: true });
      if (signal?.aborted) throw signal.reason;
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new ThumbnailDownloadError(
        timedOut
          ? `Timed out after ${this.downloadTimeoutMs}ms downloading video from ${videoUrl}`
          : `Failed to fetch video from ${videoUrl}`,
        { cause },
      );
    }

    if (!response.ok || !response.body) {
      await rm(downloadDir, { recursive: true, force: true });
      throw new ThumbnailDownloadError(
        `Failed to download video from ${videoUrl}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempVideoPath), {
        signal: combinedSignal,
      });
    } catch (cause) {
      await rm(downloadDir, { recursive: true, force: true });
      if (signal?.aborted) throw signal.reason;
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new ThumbnailDownloadError(
        timedOut
          ? `Timed out after ${this.downloadTimeoutMs}ms downloading video from ${videoUrl}`
          : `Failed to save downloaded video from ${videoUrl}`,
        { cause },
      );
    }

    return { tempVideoPath, downloadDir };
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

    await this.#ensureDir(this.thumbsDir);

    const thumbnailFilename = filename
      ? this.#validateCustomFilename(filename)
      : `${sanitizeBaseName(path.basename(videoLocalPath, path.extname(videoLocalPath)))}-${uniqueSuffix()}.png`;

    const ext = extensionFromPath(videoLocalPath);

    return new Promise((resolve, reject) => {
      const command = ffmpeg(videoLocalPath);
      if (ext) {
        command.inputFormat(ext);
      }

      const onAbort = () => command.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      const stopWatchingAbort = () => signal?.removeEventListener('abort', onAbort);

      command
        .on('end', () => {
          stopWatchingAbort();
          resolve(path.join(this.thumbsDir, thumbnailFilename));
        })
        .on('error', (cause) => {
          stopWatchingAbort();
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          reject(
            new ThumbnailGenerationError(`Failed to generate thumbnail for ${videoLocalPath}`, { cause }),
          );
        })
        .screenshots({
          timemarks: [timestamp],
          folder: this.thumbsDir,
          filename: thumbnailFilename,
          ...(size ? { size } : {}),
        });
    });
  }

  /**
   * @param {string} filename
   * @returns {string}
   */
  #validateCustomFilename(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('options.filename must be a non-empty string');
    }
    if (path.basename(filename) !== filename) {
      throw new TypeError('options.filename must be a bare filename, not a path (no directory separators)');
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
