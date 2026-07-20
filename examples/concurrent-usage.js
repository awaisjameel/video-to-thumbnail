import { fileURLToPath } from 'node:url';
import { ThumbnailGenerator } from '../src/index.js';

const localVideoPath = fileURLToPath(new URL('../test/fixtures/sample-video.mp4', import.meta.url));
const remoteVideoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

// Concurrency is capped per-instance (default 5) regardless of how many
// videos are submitted at once.
const thumbnailGenerator = new ThumbnailGenerator({ concurrency: 2 });

const results = await thumbnailGenerator.getVideoThumbnails([
  localVideoPath,
  remoteVideoUrl,
  'https://not-a-real-host.example/does-not-exist.mp4',
]);

for (const result of results) {
  if (result.error) {
    console.error(`${result.input} -> failed: ${result.error.message}`);
  } else {
    console.log(`${result.input} -> ${result.thumbnailPath}`);
  }
}
