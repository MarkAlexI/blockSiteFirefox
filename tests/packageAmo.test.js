import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageAmo, runtimePaths } from '../tools/package-amo.js';

function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP central directory');
  let offset = archive.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    const method = archive.readUInt16LE(offset + 10);
    const size = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = archive.readUInt32LE(offset + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const content = archive.subarray(start, start + size);
    if (!name.endsWith('/')) files.set(name, method === 8 ? inflateRawSync(content) : content);
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  return files;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'bd-amo-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']);
  for (const entry of runtimePaths) {
    const filename = path.join(root, entry.includes('.') ? entry : `${entry}/fixture.js`);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, `fixture:${entry}`);
  }
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: '5.3.17',
    browser_specific_settings: { gecko: { id: 'bd-test@example.test' } }, background: { scripts: ['scripts/fixture.js'] } }));
  writeFileSync(path.join(root, 'README.md'), 'Never include development documentation.');
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture']);
  return { root, git };
}

test('AMO package contains only tracked runtime bytes and records its exact commit and checksum', t => {
  const { root, git } = fixture(t);
  writeFileSync(path.join(root, 'local-note.txt'), 'untracked development file');
  const result = packageAmo(root);
  const archive = path.join(root, 'dist', result.filename);
  assert.equal(result.commit, git(['rev-parse', 'HEAD']));
  assert.equal(result.runtimeFiles.length, runtimePaths.length);
  assert.equal(result.signed, false);
  assert.equal(result.runtimeFiles.some(file => file.path === 'README.md'), false);
  assert.equal(result.sha256, createHash('sha256').update(readFileSync(archive)).digest('hex'));
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${result.sha256}  ${result.filename}\n`);
  assert.deepEqual(JSON.parse(readFileSync(`${archive}.build.json`, 'utf8')), result);
  const files = unzip(readFileSync(archive));
  assert.equal(files.size, result.runtimeFiles.length);
  assert.equal(files.has('README.md'), false);
  for (const entry of result.runtimeFiles) assert.equal(files.get(entry.path).toString(), git(['show', `HEAD:${entry.path}`]));
});

test('AMO packaging rejects modified, newly added and missing runtime files', t => {
  const { root } = fixture(t);
  const file = path.join(root, 'popup.js'); const original = readFileSync(file);
  writeFileSync(file, 'local edit');
  assert.throws(() => packageAmo(root), /Commit runtime changes/);
  writeFileSync(file, original);
  const added = path.join(root, 'scripts/untracked.js'); writeFileSync(added, 'new runtime');
  assert.throws(() => packageAmo(root), /Commit runtime changes/);
  rmSync(added); rmSync(file);
  assert.throws(() => packageAmo(root), /Commit runtime changes/);
});

test('AMO packaging rejects a committed incomplete runtime tree', t => {
  const { root, git } = fixture(t);
  git(['rm', 'popup.js']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'incomplete']);
  assert.throws(() => packageAmo(root), /Required runtime path is missing/);
});
