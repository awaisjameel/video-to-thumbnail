# video-to-thumbnail

Generate PNG thumbnails from local video files or remote video URLs using [ffmpeg](https://ffmpeg.org/), with built-in concurrency control, streamed downloads, and zero required configuration.

[![CI](https://github.com/awaisjameel/video-to-thumbnail/actions/workflows/ci.yml/badge.svg)](https://github.com/awaisjameel/video-to-thumbnail/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/video-to-thumbnail.svg)](https://www.npmjs.com/package/video-to-thumbnail)
[![license](https://img.shields.io/npm/l/video-to-thumbnail.svg)](./LICENSE)

- Works with **local file paths** and **`http(s)` URLs** — remote videos are streamed to disk, never buffered fully in memory.
- **Bounded concurrency** per instance, so fanning out over hundreds of videos never spawns unbounded ffmpeg processes or downloads.
- Ships an **ffmpeg binary** ([`@ffmpeg-installer/ffmpeg`](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg)) — no system ffmpeg install required, though you can point at your own.
- **Zero configuration required** — sensible defaults, fully overridable.
- Ships **TypeScript declarations** generated from JSDoc, and typed error classes with stable `error.code` values.
- Pure ESM, no CommonJS.

## Requirements

- Node.js **>= 20.12.0** (uses native `fetch`, `AbortSignal.timeout`, and `node:stream/promises`)

## Install

```bash
npm install video-to-thumbnail
```

## Quick start

```js
import { ThumbnailGenerator } from 'video-to-thumbnail';

const generator = new ThumbnailGenerator();

const thumbnailPath = await generator.getVideoThumbnail('./videos/clip.mp4');
console.log(thumbnailPath); // /abs/path/to/thumbnails/clip-a1b2c3d4.png
```

Remote URLs work the same way — the video is downloaded to a temp directory, a frame is extracted, and the temp file is removed automatically, even if generation fails:

```js
const thumbnailPath = await generator.getVideoThumbnail(
  'https://example.com/videos/clip.mp4',
);
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

## API

### `new ThumbnailGenerator(options?)`

| Option              | Type     | Default          | Description                                                                                   |
| ------------------- | -------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `thumbsDir`          | `string` | `"thumbnails"`   | Directory thumbnails are written to (created if missing). Resolved relative to `process.cwd()`. |
| `tempDir`            | `string` | `"temp"`         | Directory used to stage downloaded videos before processing. Created and cleaned up automatically. |
| `concurrency`        | `number` | `5`              | Max thumbnails generated at once by this instance. Must be a positive integer.                  |
| `timestamp`          | `string` | `"1"`            | ffmpeg timemark to capture the frame from — seconds (`"2.5"`) or a percentage (`"50%"`).         |
| `downloadTimeoutMs`  | `number` | `30000`          | Abort remote downloads that take longer than this.                                              |
| `ffmpegPath`         | `string` | bundled binary   | Path to an ffmpeg executable, if you'd rather not use the bundled one. **Process-global** — see note below. |

### `generator.getVideoThumbnail(videoPathOrUrl: string): Promise<string>`

Generates a thumbnail for one local path or `http(s)` URL. Resolves with the **absolute filesystem path** to the generated PNG. Rejects with a `ThumbnailDownloadError` or `ThumbnailGenerationError` on failure.

### `generator.getVideoThumbnails(videoPathsOrUrls: string[]): Promise<Array<{ input, thumbnailPath } | { input, error }>>`

Generates thumbnails for many videos at once, respecting the instance's concurrency limit. Never rejects — failures are reported per-item.

## Errors

All errors extend `ThumbnailError` (itself an `Error`) and carry a stable `code`:

| Class                        | `code`                        | Thrown when...                                      |
| ----------------------------- | ------------------------------ | ---------------------------------------------------- |
| `ThumbnailDownloadError`      | `THUMBNAIL_DOWNLOAD_FAILED`    | A remote URL can't be fetched, saved, or times out.  |
| `ThumbnailGenerationError`    | `THUMBNAIL_GENERATION_FAILED`  | ffmpeg fails to extract a frame from the video.      |

The original underlying error is always preserved on `error.cause`.

```js
import { ThumbnailError } from 'video-to-thumbnail';

try {
  await generator.getVideoThumbnail(videoPathOrUrl);
} catch (error) {
  if (error instanceof ThumbnailError) {
    console.error(error.code, error.message, error.cause);
  }
}
```

## Examples

Runnable end-to-end examples live in [`examples/`](./examples) (one local file + one real network download each):

```bash
npm run example             # sequential usage
npm run example:concurrent  # batched, fault-tolerant usage
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

**Why keep `fluent-ffmpeg` if it's deprecated on npm?**
It's a thin, stable wrapper around the ffmpeg CLI with no real behavioral risk from being unmaintained — it hasn't needed to change because the interface it wraps (the ffmpeg command line) hasn't changed. It's still used by a huge number of production packages. This is revisited if that ever stops being true.

**Can I use a newer/system ffmpeg instead of the bundled one?**
Yes — pass `ffmpegPath` to the constructor. Note that `fluent-ffmpeg` caches this path at the module level rather than per-instance, so it applies process-wide: the last `ThumbnailGenerator` constructed wins for every instance in the process, not just the one you passed it to. This is a limitation of `fluent-ffmpeg` itself. If you need different ffmpeg binaries per instance in the same process, run them in separate processes/workers.

## Contributing

```bash
git clone https://github.com/awaisjameel/video-to-thumbnail.git
cd video-to-thumbnail
pnpm install
pnpm test        # node:test, includes real ffmpeg + mocked network calls
pnpm typecheck    # tsc over the JSDoc-typed source, no build output
pnpm build        # emits .d.ts files to dist/
```

## License

[MIT](./LICENSE) © [awaisjameel](https://github.com/awaisjameel)
