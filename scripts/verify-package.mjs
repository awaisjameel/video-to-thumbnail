import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.resolve(os.tmpdir());
const consumer = await mkdtemp(path.join(temporaryRoot, 'thumbnail-package-test-'));
const manager = process.env.npm_execpath;
assert.ok(
  manager && path.isAbsolute(manager),
  'Run via pnpm run test:package or npm run test:package.',
);
const pnpm = path.basename(manager).startsWith('pnpm');
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
function packageCommand(args, cwd) {
  return /\.(?:c?js|mjs)$/.test(manager)
    ? run(process.execPath, [manager, ...args], cwd)
    : run(manager, args, cwd);
}
try {
  const result = JSON.parse(packageCommand(['pack', '--json', '--pack-destination', consumer]));
  const packed = Array.isArray(result)
    ? result[0]
    : result.files
      ? result
      : Object.values(result)[0];
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const archive = path.resolve(
    consumer,
    packed.filename || `${manifest.name}-${manifest.version}.tgz`,
  );
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { 'video-to-thumbnail': `file:${archive.replaceAll('\\', '/')}` },
    }),
  );
  packageCommand(
    ['install', '--ignore-scripts', ...(pnpm ? ['--prod'] : ['--omit=dev', '--no-fund'])],
    consumer,
  );
  const installed = path.join(consumer, 'node_modules/video-to-thumbnail');
  const installedManifest = JSON.parse(
    await readFile(path.join(installed, 'package.json'), 'utf8'),
  );
  assert.equal(installedManifest.version, manifest.version);
  for (const filename of [
    'index.js',
    'ThumbnailGenerator.js',
    'errors.js',
    'media.js',
    'paths.js',
  ]) {
    assert.deepEqual(
      await readFile(path.join(installed, 'src', filename)),
      await readFile(path.join(root, 'src', filename)),
    );
    await readFile(path.join(installed, 'dist', filename.replace(/\.js$/, '.d.ts')));
  }
  await cp(path.join(root, 'test/fixtures/sample-video.mp4'), path.join(consumer, 'video.mp4'));
  await cp(path.join(root, 'scripts/consumer-smoke.mjs'), path.join(consumer, 'smoke.mjs'));
  console.log(run(process.execPath, ['smoke.mjs'], consumer).trim());
  // TypeScript consumers supply their Node development types; runtime checks
  // above intentionally ran before adding any development dependencies.
  packageCommand(['add', '-D', '@types/node@^26.6.5'], consumer);
  await writeFile(
    path.join(consumer, 'types.mts'),
    `import { ThumbnailGenerator, ThumbnailError } from 'video-to-thumbnail';
const generator = new ThumbnailGenerator({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', concurrency: 2 });
const file: string = await generator.getVideoThumbnail('video.mp4', { timestamp: '50%', signal: new AbortController().signal });
for (const result of await generator.getVideoThumbnails([file])) { if (result.thumbnailPath) result.thumbnailPath.toUpperCase(); }
const code: string = new ThumbnailError('test', { code: 'TEST' }).code;
void code;
`,
  );
  run(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2023',
      '--types',
      'node',
      'types.mts',
    ],
    consumer,
  );
  packageCommand(['audit', ...(pnpm ? ['--prod'] : ['--omit=dev'])], consumer);
  console.log(
    `Packed ${manifest.version}: byte-verified runtime files, production consumer and strict TypeScript declarations pass.`,
  );
} finally {
  assert.equal(path.dirname(path.resolve(consumer)), temporaryRoot);
  assert.ok(path.basename(consumer).startsWith('thumbnail-package-test-'));
  await rm(consumer, { recursive: true, force: true });
}
