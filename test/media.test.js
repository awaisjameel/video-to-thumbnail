import { describe, it } from 'node:test';
import { parseTimestamp, runMediaTool, scaleFilter } from '../src/media.js';

describe('media arguments', () => {
  it('preserves seconds, clock and percentage timestamps', (t) => {
    t.assert.deepEqual(parseTimestamp('2.5'), { seconds: 2.5 });
    t.assert.deepEqual(parseTimestamp('01:02.5'), { seconds: 62.5 });
    t.assert.deepEqual(parseTimestamp('01:02:03.5'), { seconds: 3723.5 });
    t.assert.deepEqual(parseTimestamp('50%'), { percent: 50 });
  });
  it('rejects invalid timestamps before invoking a tool', (t) => {
    for (const timestamp of ['', '-1', 'NaN', '01:99', '101%', '1;exit'])
      t.assert.throws(() => parseTimestamp(timestamp));
  });
  it('preserves documented scale modes and even rounding', (t) => {
    t.assert.equal(scaleFilter('321x241'), 'scale=322:242');
    t.assert.equal(scaleFilter('80x?'), 'scale=80:trunc(ow/a/2)*2');
    t.assert.equal(scaleFilter('?x80'), 'scale=trunc(oh*a/2)*2:80');
    t.assert.equal(scaleFilter('50%'), 'scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2');
  });
  it('rejects arbitrary filters and zero dimensions', (t) => {
    for (const size of ['', '0x100', '0%', '80x?;movie=external', 'scale=100:100'])
      t.assert.throws(() => scaleFilter(size));
  });
});

describe('media subprocesses', () => {
  it('preserves argument bytes without shell interpretation', async (t) => {
    const argument = 'a path with spaces; $(echo injected) & 日本語';
    const result = await runMediaTool(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      argument,
    ]);
    t.assert.equal(result, argument);
  });
  it('retains diagnostic output from failing processes', async (t) => {
    await t.assert.rejects(
      runMediaTool(process.execPath, ['-e', 'process.stderr.write("diagnostic");process.exit(2)']),
      /diagnostic/,
    );
  });
  it('terminates running processes and preserves a custom cancellation reason', async (t) => {
    const controller = new AbortController();
    const reason = new Error('stop media work');
    const promise = runMediaTool(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      controller.signal,
    );
    setTimeout(() => controller.abort(reason), 20);
    await t.assert.rejects(promise, (error) => error === reason);
  });
  it('bounds stdout from a misbehaving executable', async (t) => {
    await t.assert.rejects(
      runMediaTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))']),
      /output limit/,
    );
  });
});
