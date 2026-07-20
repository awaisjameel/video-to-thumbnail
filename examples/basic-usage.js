import { fileURLToPath } from 'node:url';
import { ThumbnailGenerator } from '../src/index.js';

const localVideoPath = fileURLToPath(new URL('../test/fixtures/sample-video.mp4', import.meta.url));
const remoteVideoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

const thumbnailGenerator = new ThumbnailGenerator();

for (const videoPathOrUrl of [localVideoPath, remoteVideoUrl]) {
  const thumbnailPath = await thumbnailGenerator.getVideoThumbnail(videoPathOrUrl);
  console.log(`${videoPathOrUrl} -> ${thumbnailPath}`);
}
