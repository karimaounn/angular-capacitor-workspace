#!/usr/bin/env node
// tsc only emits .js/.d.ts. The schematics runtime also needs collection.json,
// every schema.json and every template tree under src/**/files/ to sit beside
// the compiled factories, at the same relative paths.
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkgRoot, 'src');
const out = join(pkgRoot, 'dist');

/** Everything tsc ignores but the runtime resolves by path. */
function isAsset(path) {
  const rel = relative(src, path);
  return rel.split('/').includes('files') || path.endsWith('.json');
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let copied = 0;
for await (const file of walk(src)) {
  if (!isAsset(file)) continue;
  const target = join(out, relative(src, file));
  await mkdir(dirname(target), { recursive: true });
  await cp(file, target);
  copied++;
}

// The CLI is a bin entry; npm sets the executable bit from the manifest on
// install, but a locally linked dist needs it too.
const cli = join(out, 'cli', 'index.js');
try {
  await stat(cli);
  const { chmod } = await import('node:fs/promises');
  await chmod(cli, 0o755);
} catch {
  // CLI not built yet (partial build) — not fatal for asset copying.
}

console.log(`copy-assets: ${copied} file(s) -> dist/`);
