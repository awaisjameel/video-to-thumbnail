import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 64 * 1024;

/**
 * Run an executable directly, drain its pipes and await close before cleanup.
 * No shell is involved; paths and media options remain separate arguments.
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export function runMediaTool(executable, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    /** @type {Error | undefined} */
    let failure;
    const onAbort = () => {
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failure ??= new Error(`${path.basename(executable)} exceeded its output limit`);
        child.kill('SIGKILL');
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (/** @type {string} */ chunk) => {
      stderr = (stderr + chunk).slice(-MAX_ERROR_CHARS);
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code, terminationSignal) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `${path.basename(executable)} exited with ${code ?? terminationSignal}: ${stderr.trim()}`,
          ),
        );
      else resolve(stdout);
    });
  });
}

/**
 * @param {string} timestamp
 * @returns {{ seconds: number } | { percent: number }}
 */
export function parseTimestamp(timestamp) {
  if (typeof timestamp !== 'string' || timestamp.length === 0)
    throw new TypeError('timestamp must be a non-empty string');
  if (/^\d+(?:\.\d+)?%$/.test(timestamp)) {
    const percent = Number(timestamp.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100)
      throw new RangeError('timestamp percentage must be between 0 and 100');
    return { percent };
  }
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(timestamp))
    throw new TypeError('timestamp must be non-negative seconds, HH:MM:SS, MM:SS or a percentage');
  const parts = timestamp.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some((value) => value >= 60))
    throw new RangeError('timestamp minute and second components must be less than 60');
  const seconds = parts.reduce((total, value) => total * 60 + value, 0);
  if (!Number.isFinite(seconds)) throw new RangeError('timestamp must be finite');
  return { seconds };
}

/**
 * @param {string} timestamp
 * @param {string} video
 * @param {string} ffprobePath
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>}
 */
export async function resolveTimestamp(timestamp, video, ffprobePath, signal) {
  const parsed = parseTimestamp(timestamp);
  if ('seconds' in parsed) return parsed.seconds;
  const text = await runMediaTool(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=duration:format=duration',
      '-of',
      'json',
      video,
    ],
    signal,
  );
  /** @type {unknown} */
  const decoded = JSON.parse(text);
  if (typeof decoded !== 'object' || decoded === null)
    throw new Error('ffprobe returned invalid metadata');
  const metadata =
    /** @type {{ streams?: Array<{duration?: unknown}>, format?: {duration?: unknown} }} */ (
      decoded
    );
  const streamDuration = Number(metadata.streams?.[0]?.duration);
  const duration =
    Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration
      : Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error('Video duration is unavailable; use an absolute timestamp');
  return (duration * parsed.percent) / 100;
}

/**
 * Match the established size syntax and even-dimension rounding without accepting
 * arbitrary FFmpeg filter expressions from caller input.
 * @param {string | undefined} size
 * @returns {string | undefined}
 */
export function scaleFilter(size) {
  if (size === undefined) return undefined;
  if (typeof size !== 'string')
    throw new TypeError('size must be a dimension or percentage string');
  const fixed = /^(\d+)x(\d+)$/.exec(size);
  const width = /^(\d+)x\?$/.exec(size);
  const height = /^\?x(\d+)$/.exec(size);
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(size);
  /** @param {string} value */
  const even = (value) => {
    const dimension = Number(value);
    if (!Number.isSafeInteger(dimension) || dimension < 1)
      throw new RangeError('size dimensions must be positive safe integers');
    return Math.round(dimension / 2) * 2;
  };
  if (fixed) return `scale=${even(fixed[1])}:${even(fixed[2])}`;
  if (width) return `scale=${even(width[1])}:trunc(ow/a/2)*2`;
  if (height) return `scale=trunc(oh*a/2)*2:${even(height[1])}`;
  if (percent) {
    const ratio = Number(percent[1]) / 100;
    if (!Number.isFinite(ratio) || ratio <= 0)
      throw new RangeError('size percentage must be positive and finite');
    return `scale=trunc(iw*${ratio}/2)*2:trunc(ih*${ratio}/2)*2`;
  }
  throw new TypeError('size must be WIDTHxHEIGHT, WIDTHx?, ?xHEIGHT or a percentage');
}
