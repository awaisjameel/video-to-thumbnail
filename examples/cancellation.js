import { fileURLToPath } from 'node:url';
import { ThumbnailGenerator } from '../src/index.js';

const localVideoPath = fileURLToPath(new URL('../test/fixtures/sample-video.mp4', import.meta.url));

const thumbnailGenerator = new ThumbnailGenerator();

// Cancel a single in-flight call (works whether it's still downloading a
// remote URL or already running ffmpeg on a local file). This is the same
// AbortController/AbortSignal pattern used by fetch.
const controller = new AbortController();
setTimeout(() => controller.abort(), 5);

try {
  const thumbnailPath = await thumbnailGenerator.getVideoThumbnail(localVideoPath, { signal: controller.signal });
  console.log(`not cancelled in time, generated: ${thumbnailPath}`);
} catch (error) {
  // On abort, the promise rejects with the signal's own abort reason
  // (name "AbortError"), not a ThumbnailError -- cancellation isn't a failure.
  console.log(`cancelled as expected: ${error.name} - ${error.message}`);
}

// The same signal also works for a whole batch via getVideoThumbnails,
// e.g. tied to an HTTP request's AbortSignal so a client disconnect stops
// all in-flight work for that request.
const batchController = new AbortController();
setTimeout(() => batchController.abort(), 5);

const results = await thumbnailGenerator.getVideoThumbnails([localVideoPath, localVideoPath], {
  signal: batchController.signal,
});
for (const result of results) {
  console.log(result.error ? `batch item cancelled: ${result.error.name}` : result.thumbnailPath);
}
