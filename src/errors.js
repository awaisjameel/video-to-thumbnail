/**
 * Base class for all errors raised by this package. Lets consumers do
 * `error instanceof ThumbnailError` to distinguish library failures from
 * unrelated errors (e.g. a bug in their own code).
 */
export class ThumbnailError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, cause?: unknown }} options
   */
  constructor(message, { code, cause }) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** Thrown when a remote video URL cannot be downloaded. */
export class ThumbnailDownloadError extends ThumbnailError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: 'THUMBNAIL_DOWNLOAD_FAILED', ...options });
  }
}

/** Thrown when ffmpeg fails to extract a frame from a video. */
export class ThumbnailGenerationError extends ThumbnailError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: 'THUMBNAIL_GENERATION_FAILED', ...options });
  }
}
