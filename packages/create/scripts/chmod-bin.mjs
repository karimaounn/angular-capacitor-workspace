#!/usr/bin/env node
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
await chmod(join(pkgRoot, 'dist', 'index.js'), 0o755);
