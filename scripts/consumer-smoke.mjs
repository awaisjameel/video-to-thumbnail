import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { ThumbnailGenerator, ThumbnailGenerationError } from 'video-to-thumbnail';

const video = path.resolve('video.mp4');
const generator = new ThumbnailGenerator({
  thumbsDir: path.resolve('output'),
  tempDir: path.resolve('temp'),
});
const bytes = await readFile(video);
const server = http.createServer((request, response) => response.end(bytes));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const output = await generator.getVideoThumbnail(video, { size: '80x?', filename: 'local.png' });
  const png = await readFile(output);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(png.readUInt32BE(16), 80);
  const remote = await generator.getVideoThumbnail(
    `http://127.0.0.1:${server.address().port}/video`,
    { timestamp: '50%' },
  );
  assert.ok((await readFile(remote)).length > 8);
  const results = await generator.getVideoThumbnails([video, 'missing-video.mp4']);
  assert.ok(results[0].thumbnailPath);
  assert.ok(results[1].error instanceof ThumbnailGenerationError);
  console.log(
    'Packed ESM consumer: actual FFmpeg PNG dimensions, FFprobe percentages, streamed HTTP and mixed batches pass.',
  );
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
