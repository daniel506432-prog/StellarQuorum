import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const budgets = [
  ['root', 'dist/esm/index.js', 25 * 1024],
  ['freighter', 'dist/esm/freighter.js', 35 * 1024],
];
let failed = false;
for (const [name, relative, budget] of budgets) {
  const path = resolve(relative);
  const compressed = gzipSync(readFileSync(path), { level: 9 });
  const raw = statSync(path).size;
  console.log(`${name}: ${raw} bytes raw, ${compressed.length} bytes gzip (budget ${budget})`);
  if (compressed.length > budget) {
    console.error(`${name} bundle exceeds its gzip budget`);
    failed = true;
  }
}
if (failed) process.exit(1);
