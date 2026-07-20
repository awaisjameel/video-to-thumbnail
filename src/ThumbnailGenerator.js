import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import ffmpeg from 'fluent-ffmpeg';
import { path as bundledFfmpegPath } from '@ffmpeg-installer/ffmpeg';
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

  /**
   * @param {object} [options]
   * @param {string} [options.thumbsDir] Directory thumbnails are written to. Created if missing. Default: `"thumbnails"` (relative to `process.cwd()`).
   * @param {string} [options.tempDir] Directory used to stage downloaded videos before they're processed. Created and cleaned up automatically. Default: `"temp"` (relative to `process.cwd()`).
   * @param {number} [options.concurrency] Maximum number of thumbnails generated at once by this instance. Default: `5`.
   * @param {string} [options.timestamp] ffmpeg timemark (seconds, or `"50%"`-style percentage) to capture the frame from. Default: `"1"`.
   * @param {number} [options.downloadTimeoutMs] Abort downloads that take longer than this. Default: `30000`.
   * @param {string} [options.ffmpegPath] Path to an ffmpeg binary. Defaults to the one bundled via `@ffmpeg-installer/ffmpeg`.
   *   Note: fluent-ffmpeg caches this path at the module level, so setting it applies process-wide — the
   *   last `ThumbnailGenerator` constructed "wins" for every instance, not just the one it was passed to.
   */
  constructor(options = {}) {
    const {
      thumbsDir = 'thumbnails',
      tempDir = 'temp',
      concurrency = DEFAULT_CONCURRENCY,
      timestamp = DEFAULT_TIMESTAMP,
      downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
      ffmpegPath = bundledFfmpegPath,
    } = options;

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('options.concurrency must be a positive integer');
    }

    this.thumbsDir = path.resolve(thumbsDir);
    this.downloadsDir = path.resolve(tempDir, 'downloads');
    this.timestamp = timestamp;
    this.downloadTimeoutMs = downloadTimeoutMs;

    this.#limit = pLimit(concurrency);
    // fluent-ffmpeg has no per-instance concept of the ffmpeg binary path: this mutates
    // shared, process-global state (see the ffmpegPath doc comment above).
    ffmpeg.setFfmpegPath(ffmpegPath);
  }

  /**
   * Generates a thumbnail for a single local file path or `http(s)` URL,
   * queued behind this instance's concurrency limit.
   * @param {string} videoPathOrUrl
   * @returns {Promise<string>} Absolute filesystem path to the generated PNG.
   */
  async getVideoThumbnail(videoPathOrUrl) {
    return this.#limit(() => this.#generateFromInput(videoPathOrUrl));
  }

  /**
   * Generates thumbnails for many videos, respecting this instance's
   * concurrency limit. Unlike {@link getVideoThumbnail}, failures for
   * individual inputs don't reject the whole batch — each result reports
   * either a `thumbnailPath` or an `error`.
   * @param {readonly string[]} videoPathsOrUrls
   * @returns {Promise<Array<ThumbnailSuccess | ThumbnailFailure>>}
   */
  async getVideoThumbnails(videoPathsOrUrls) {
    const settled = await Promise.allSettled(
      videoPathsOrUrls.map((videoPathOrUrl) => this.getVideoThumbnail(videoPathOrUrl)),
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
   * @returns {Promise<string>}
   */
  async #generateFromInput(videoPathOrUrl) {
    if (typeof videoPathOrUrl !== 'string' || videoPathOrUrl.length === 0) {
      throw new TypeError('videoPathOrUrl must be a non-empty string');
    }

    if (!isHttpUrl(videoPathOrUrl)) {
      return this.#generateThumbnail(videoPathOrUrl);
    }

    const { tempVideoPath, downloadDir } = await this.#downloadToTempFile(videoPathOrUrl);
    try {
      return await this.#generateThumbnail(tempVideoPath);
    } finally {
      await rm(downloadDir, { recursive: true, force: true });
    }
  }

  /**
   * Downloads `videoUrl` into a uniquely-named temp directory so concurrent
   * downloads of same-named files never collide.
   * @param {string} videoUrl
   * @returns {Promise<{ tempVideoPath: string, downloadDir: string }>}
   */
  async #downloadToTempFile(videoUrl) {
    await mkdir(this.downloadsDir, { recursive: true });
    const downloadDir = await mkdtemp(path.join(this.downloadsDir, 'dl-'));

    const ext = extensionFromUrl(videoUrl);
    const baseName = sanitizeBaseName(baseNameFromUrl(videoUrl));
    const tempVideoPath = path.join(downloadDir, ext ? `${baseName}.${ext}` : baseName);

    let response;
    try {
      response = await fetch(videoUrl, { signal: AbortSignal.timeout(this.downloadTimeoutMs) });
    } catch (cause) {
      await rm(downloadDir, { recursive: true, force: true });
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
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempVideoPath));
    } catch (cause) {
      await rm(downloadDir, { recursive: true, force: true });
      throw new ThumbnailDownloadError(`Failed to save downloaded video from ${videoUrl}`, { cause });
    }

    return { tempVideoPath, downloadDir };
  }

  /**
   * Extracts a single frame from `videoLocalPath` and writes it as a PNG
   * into {@link thumbsDir}.
   * @param {string} videoLocalPath
   * @returns {Promise<string>}
   */
  async #generateThumbnail(videoLocalPath) {
    await mkdir(this.thumbsDir, { recursive: true });

    const ext = extensionFromPath(videoLocalPath);
    const baseName = sanitizeBaseName(path.basename(videoLocalPath, path.extname(videoLocalPath)));
    const thumbnailFilename = `${baseName}-${uniqueSuffix()}.png`;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(videoLocalPath);
      if (ext) {
        command.inputFormat(ext);
      }

      command
        .on('end', () => resolve(path.join(this.thumbsDir, thumbnailFilename)))
        .on('error', (cause) => {
          reject(
            new ThumbnailGenerationError(`Failed to generate thumbnail for ${videoLocalPath}`, { cause }),
          );
        })
        .screenshots({
          timemarks: [this.timestamp],
          folder: this.thumbsDir,
          filename: thumbnailFilename,
        });
    });
  }
}
