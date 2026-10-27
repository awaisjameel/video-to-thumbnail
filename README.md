# video-to-thumbnail

Generate PNG thumbnails from local video files or remote video URLs using [ffmpeg](https://ffmpeg.org/) — with built-in concurrency control, streamed downloads, cancellation, and per-instance executable settings.

[![CI](https://github.com/awaisjameel/video-to-thumbnail/actions/workflows/ci.yml/badge.svg)](https://github.com/awaisjameel/video-to-thumbnail/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/video-to-thumbnail.svg)](https://www.npmjs.com/package/video-to-thumbnail)
[![license](https://img.shields.io/npm/l/video-to-thumbnail.svg)](./LICENSE)

- Works with **local file paths** and **`http(s)` URLs** — remote videos are streamed to disk, never buffered fully in memory.
- **Bounded concurrency** per instance, so fanning out over hundreds of videos never spawns unbounded ffmpeg processes or downloads.
- **Cancellable** — pass a standard `AbortSignal` to stop an in-flight download or ffmpeg run early.
- **Fully customizable per call** — override the capture timestamp, resize the output, or pin an exact output filename, all without touching instance-wide defaults.
- Uses your **current FFmpeg and FFprobe installation**. Put them on PATH or set executable paths per instance. No deprecated wrappers or old bundled binaries.
- Sensible generation defaults, fully overridable. Completed PNGs replace destinations atomically.
- **Fails fast** with a typed error for missing/invalid local files, instead of spawning ffmpeg only to have it fail.
- Ships **TypeScript declarations** generated from JSDoc, and typed error classes with stable `error.code` values.
- Pure ESM, no CommonJS. CI targets Linux, macOS, and Windows.

## Requirements

- Maintained Node.js **22, 24 or 26** (minimum 22.18.0 / 24.11.0 on those lines).
- A current [FFmpeg release and matching FFprobe](https://ffmpeg.org/download.html) on PATH, or explicit executable paths. Current verification targets FFmpeg 9.0.2. FFprobe is needed for percentage timestamps.

## Install

```bash
npm install video-to-thumbnail
```

Upgrading from 1.x? See [MIGRATION.md](./MIGRATION.md) for binary setup and other major-release changes.

## Quick start

```js
import { ThumbnailGenerator } from 'video-to-thumbnail';

const generator = new ThumbnailGenerator();

const thumbnailPath = await generator.getVideoThumbnail('./videos/clip.mp4');
console.log(thumbnailPath); // /abs/path/to/thumbnails/clip-a1b2c3d4.png
```

Remote URLs work the same way — the video is downloaded to a temp directory, a frame is extracted, and the temp file is removed automatically, even if generation fails:

```js
const thumbnailPath = await generator.getVideoThumbnail('https://example.com/videos/clip.mp4');
```

## Concurrency

Every call made through a `ThumbnailGenerator` instance shares a single concurrency limiter (default: `5`). This applies uniformly whether you call `getVideoThumbnail` directly in a loop, via `Promise.all`, or through `getVideoThumbnails` — there's no separate "unbounded" method to accidentally reach for and overload the machine with concurrent ffmpeg processes or downloads.

```js
const generator = new ThumbnailGenerator({ concurrency: 3 });

// Only 3 videos are downloaded/processed at a time, however many you pass.
const results = await generator.getVideoThumbnails(videoPathsOrUrls);
```

`getVideoThumbnails` is fault-tolerant: a failure on one input doesn't reject the whole batch. Each result is either `{ input, thumbnailPath }` or `{ input, error }`:

```js
const results = await generator.getVideoThumbnails([
  './videos/a.mp4',
  'https://example.com/broken.mp4',
]);

for (const result of results) {
  if (result.error) {
    console.error(`${result.input} failed:`, result.error);
  } else {
    console.log(`${result.input} -> ${result.thumbnailPath}`);
  }
}
```

If you want a single call that rejects on failure, use `getVideoThumbnail` (singular) directly — it still respects the same concurrency limit:

```js
try {
  const thumbnailPath = await generator.getVideoThumbnail(videoPathOrUrl);
} catch (error) {
  console.error(error);
}
```

## Per-call options

Every generation method takes an optional second argument to override instance defaults for that call only — no need to spin up a second `ThumbnailGenerator` just to capture one video differently.

```js
const thumbnailPath = await generator.getVideoThumbnail(videoPathOrUrl, {
  timestamp: '50%', // capture the middle frame instead of the instance default
  size: '320x?', // fixed width, aspect-ratio-preserving height
  filename: 'preview.png', // exact output filename, no random suffix
});
```

| Option      | Type          | Description                                                                                                                                                                                                                                    |
| ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp` | `string`      | ffmpeg timemark to capture — seconds (`"2.5"`) or a percentage (`"50%"`). Overrides the constructor's `timestamp`.                                                                                                                             |
| `size`      | `string`      | ffmpeg size spec for the output frame, e.g. `"320x240"`, `"320x?"` (preserve aspect ratio), or `"50%"`. Default: source resolution.                                                                                                            |
| `filename`  | `string`      | Exact output filename (e.g. `"clip.png"`), written directly under `thumbsDir` with **no** random suffix. Must be a bare filename ending in `.png` — no directory separators, no path traversal. Omit for a collision-free auto-generated name. |
| `signal`    | `AbortSignal` | Cancels this call — see [Cancellation](#cancellation) below.                                                                                                                                                                                   |

`timestamp` and `size` can also be set as defaults for every call on an instance:

```js
const generator = new ThumbnailGenerator({ timestamp: '2', size: '640x?' });
```

`getVideoThumbnails` accepts the same options object, applied to every item in the batch — handy for a shared `signal` or a batch-wide `timestamp`/`size` override. Don't pass `filename` there, though: every item would collide on the same output path. Reach for `Promise.all` over individual `getVideoThumbnail` calls (still governed by the same concurrency limit) when each input needs its own filename.

## Cancellation

Pass a standard [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) — the same one you'd hand to `fetch` — to stop a call early, whether it's still downloading or already running ffmpeg:

```js
const controller = new AbortController();

const promise = generator.getVideoThumbnail(videoPathOrUrl, { signal: controller.signal });

controller.abort(); // or wire this to req.signal, a timeout, a "cancel" button, etc.

try {
  await promise;
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('cancelled');
  } else {
    throw error;
  }
}
```

Cancellation isn't treated as a failure: the promise rejects with the signal's own abort reason (a `DOMException` named `"AbortError"` by default, or whatever you passed to `controller.abort(reason)`) — never a `ThumbnailError`. Check `error.name === 'AbortError'` (or `error === controller.signal.reason`) to distinguish an intentional cancellation from a real failure.

## API

### `new ThumbnailGenerator(options?)`

| Option              | Type     | Default           | Description                                                                                                                                   |
| ------------------- | -------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `thumbsDir`         | `string` | `"thumbnails"`    | Directory thumbnails are written to (created if missing). Resolved relative to `process.cwd()`.                                               |
| `tempDir`           | `string` | `"temp"`          | Directory used to stage downloaded videos before processing. Created and cleaned up automatically.                                            |
| `concurrency`       | `number` | `5`               | Max thumbnails generated at once by this instance. Must be a positive integer.                                                                |
| `timestamp`         | `string` | `"1"`             | Default ffmpeg timemark to capture the frame from — seconds (`"2.5"`) or a percentage (`"50%"`). Overridable per call.                        |
| `size`              | `string` | source resolution | Default ffmpeg size spec for the output frame, e.g. `"320x240"`. Overridable per call.                                                        |
| `downloadTimeoutMs` | `number` | `30000`           | Abort remote downloads that take longer than this. Must be a positive integer no greater than 4294967295.                                     |
| `ffmpegPath`        | `string` | `ffmpeg` on PATH  | Path to an ffmpeg executable, to override PATH lookup. **Per instance**.                                                                      |
| `ffprobePath`       | `string` | `ffprobe` on PATH | Path to an ffprobe executable, used only to resolve percentage-style `timestamp` values (e.g. `"50%"`) to an absolute time. **Per instance**. |

Throws `RangeError` for an invalid `concurrency` or `downloadTimeoutMs`.

### `generator.getVideoThumbnail(videoPathOrUrl, options?)`

Generates a thumbnail for one local path or `http(s)` URL, queued behind this instance's concurrency limit. Resolves with the **absolute filesystem path** to the generated PNG.

- `options`: see [Per-call options](#per-call-options).
- Rejects with `ThumbnailDownloadError` or `ThumbnailGenerationError` on failure, or the abort reason if `options.signal` fires.

### `generator.getVideoThumbnails(videoPathsOrUrls, options?)`

Generates thumbnails for many videos at once, respecting the instance's concurrency limit. Never rejects — failures are reported per-item as `{ input, error }` alongside successes as `{ input, thumbnailPath }`.

- `videoPathsOrUrls`: an array of local paths and/or `http(s)` URLs. Throws `TypeError` if not an array.
- `options`: applied to every item in the batch — see [Per-call options](#per-call-options).

## Errors

All errors extend `ThumbnailError` (itself an `Error`) and carry a stable `code`:

| Class                      | `code`                        | Thrown when...                                                             |
| -------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `ThumbnailDownloadError`   | `THUMBNAIL_DOWNLOAD_FAILED`   | A remote URL can't be fetched, saved, or times out.                        |
| `ThumbnailGenerationError` | `THUMBNAIL_GENERATION_FAILED` | The local video is missing/not a file, or ffmpeg fails to extract a frame. |

Underlying transport/process errors are preserved on `error.cause` when available.

```js
import { ThumbnailError } from 'video-to-thumbnail';

try {
  await generator.getVideoThumbnail(videoPathOrUrl);
} catch (error) {
  if (error.name === 'AbortError') {
    // Cancelled via options.signal -- not a ThumbnailError.
  } else if (error instanceof ThumbnailError) {
    console.error(error.code, error.message, error.cause);
  }
}
```

## Examples

Runnable end-to-end examples live in [`examples/`](./examples):

```bash
npm run example              # sequential usage, plus per-call timestamp/size/filename overrides
npm run example:concurrent   # batched, fault-tolerant usage
npm run example:cancellation # cancelling a single call and a whole batch via AbortSignal
```

## FAQ

**Why doesn't this package read a `.env` file?**
As a library, it shouldn't have side effects on import or assume your process lays out configuration a particular way. Pass configuration explicitly instead:

```js
new ThumbnailGenerator({
  thumbsDir: process.env.THUMBS_DIR,
  tempDir: process.env.TEMP_DIR,
});
```

**Why call FFmpeg directly?**
The wrapper is deprecated. This package needs a small, stable set of CLI operations, so it now invokes those directly with argument arrays and no shell.

**How do I choose executable paths?**
Put current executables on PATH, or pass `ffmpegPath` and its matching `ffprobePath` to the constructor:

```js
new ThumbnailGenerator({
  ffmpegPath: '/usr/local/bin/ffmpeg',
  ffprobePath: '/usr/local/bin/ffprobe',
});
```

Executable paths are independent per instance. A missing executable raises a typed generation error with the original spawn error as its cause.

**Why does resolving `timestamp: "50%"` need ffprobe?**
A percentage timemark requires the video duration. Install FFprobe alongside FFmpeg, or pass `ffprobePath`. Absolute second/clock timestamps do not invoke FFprobe.

**How do I get a deterministic output path instead of a random suffix?**
Pass `filename` per call: `generator.getVideoThumbnail(video, { filename: `${videoId}.png` })`. See [Per-call options](#per-call-options).

**How do I resize the thumbnail?**
Pass `size` (constructor default or per-call), e.g. `{ size: '320x240' }` for an exact size or `{ size: '320x?' }` to preserve aspect ratio at a fixed width.

## Contributing

```bash
git clone https://github.com/awaisjameel/video-to-thumbnail.git
cd video-to-thumbnail
pnpm install
pnpm test        # node:test, includes real ffmpeg + mocked network calls
pnpm typecheck    # tsc over the JSDoc-typed source, no build output
pnpm lint         # correctness checks over source, tests, scripts and examples
pnpm format:check # verify formatting; use pnpm format to apply it
pnpm build        # emits .d.ts files to dist/
```

CI configures the same checks on Linux, macOS, and Windows across Node 22, 24 and 26. Run `pnpm run verify` to include archive installation checks.

## License

[MIT](./LICENSE) © [awaisjameel](https://github.com/awaisjameel)
