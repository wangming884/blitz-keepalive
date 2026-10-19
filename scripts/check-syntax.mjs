#!/usr/bin/env node
/**
 * Syntax gate for every JavaScript module in the repository.
 *
 * The CI used to list files by hand, which silently skipped modules added
 * later (schedule.mjs, keepopen.mjs). Walking the tree keeps the check honest.
 */
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', '.git', '.playwright-mcp', 'artifacts', 'logs', 'data']);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        files.push(...(await collect(path.join(dir, entry.name))));
      }
      continue;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await collect(absolute)));
      continue;
    }
    if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const files = await collect(ROOT);
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = result.error?.stack || result.stderr || result.stdout || "exit code " + String(result.status ?? "unknown");
    failures.push({ file: path.relative(ROOT, file), output });
  }
}

for (const failure of failures) {
  console.error(`✗ ${failure.file}\n${failure.output.trim()}`);
}

console.log(`[check-syntax] ${files.length} files checked, ${failures.length} failed.`);
process.exit(failures.length === 0 ? 0 : 1);
