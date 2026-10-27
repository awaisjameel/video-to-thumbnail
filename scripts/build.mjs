import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, 'dist');
assert.equal(path.dirname(output), path.resolve(root));
await rm(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
