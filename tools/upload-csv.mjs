#!/usr/bin/env node
/**
 * Load a monitoring CSV into a running API, using the same chunked protocol
 * the browser uses. Handy for seeding a fresh deployment or for checking a
 * deployed Worker from a terminal.
 *
 *   node tools/upload-csv.mjs <api-base> <path-to-csv>
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [, , apiBase, csvPath] = process.argv;

if (!apiBase || !csvPath) {
  console.error('usage: node tools/upload-csv.mjs <api-base> <path-to-csv>');
  process.exit(1);
}

const base = apiBase.replace(/\/$/, '');
const ROWS_PER_CHUNK = 500;

async function call(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${text}`);
  return JSON.parse(text);
}

const text = await readFile(csvPath, 'utf8');
const lines = text.split(/\r?\n/);
const header = lines[0];
const dataLines = lines.slice(1).filter((line) => line.trim() !== '');

console.log(`${basename(csvPath)}: ${dataLines.length} data rows`);

const started = Date.now();
const { uploadId } = await call('/api/uploads', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: basename(csvPath) }),
});

for (let index = 0; index < dataLines.length; index += ROWS_PER_CHUNK) {
  const slice = dataLines.slice(index, index + ROWS_PER_CHUNK);
  await call(`/api/uploads/${uploadId}/chunk?lineOffset=${index + 1}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: `${header}\n${slice.join('\n')}`,
  });
  process.stdout.write(`\r  sent ${Math.min(index + ROWS_PER_CHUNK, dataLines.length)}/${dataLines.length}`);
}

const { upload } = await call(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(upload, null, 2));
console.log(`\nStats: ${base}/api/uploads/${uploadId}/stats`);
