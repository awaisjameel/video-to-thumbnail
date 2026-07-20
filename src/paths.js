import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Returns `true` if `value` is an absolute `http:`/`https:` URL.
 * Anything else (a bare filesystem path, a relative path, `ftp://`, etc.)
 * is treated as a local path.
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * Reduces an arbitrary string (often derived from user-controlled input,
 * such as a URL path segment) to a short, filesystem-safe basename.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeBaseName(name) {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (cleaned || 'video').slice(0, 100);
}

/**
 * Lowercased extension (no leading dot) for a filesystem path.
 * @param {string} filePath
 * @returns {string}
 */
export function extensionFromPath(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * Lowercased extension (no leading dot) for the pathname component of a URL,
 * ignoring any query string or fragment (e.g. signed URLs with `?token=...`).
 * @param {string} url
 * @returns {string}
 */
export function extensionFromUrl(url) {
  return extensionFromPath(new URL(url).pathname);
}

/**
 * Filename (without extension) for the pathname component of a URL.
 * @param {string} url
 * @returns {string}
 */
export function baseNameFromUrl(url) {
  const { pathname } = new URL(url);
  return path.basename(pathname, path.extname(pathname));
}

/**
 * Short random identifier used to keep generated filenames collision-free
 * under concurrent use.
 * @returns {string}
 */
export function uniqueSuffix() {
  return randomUUID().slice(0, 8);
}
