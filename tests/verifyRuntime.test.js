import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRuntime } from '../tools/verify-runtime.js';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'bd-runtime-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('export const STORE_TARGET = \'edge\';\n');
  mkdirSync(path.join(root, 'utils'));
  writeFileSync(path.join(root, 'utils/storeTarget.js'), bytes);
  const gitBlob = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  return { root, metadata: { commit: 'test-commit', version: '5.3.20', target: 'edge', runtimeFiles: [{ path: 'utils/storeTarget.js', gitBlob }] } };
}

test('runtime verification checks transformed store bytes and ignores only signature/integrity directories', t => {
  const { root, metadata } = fixture(t);
  for (const name of ['META-INF', '_metadata']) {
    mkdirSync(path.join(root, name)); writeFileSync(path.join(root, name, 'store-record'), 'store');
  }
  assert.equal(verifyRuntime(metadata, root).verifiedFiles, 1);
  writeFileSync(path.join(root, 'utils/storeTarget.js'), "export const STORE_TARGET = 'chrome';");
  assert.throws(() => verifyRuntime(metadata, root), /Runtime bytes differ: utils\/storeTarget.js/);
});

test('runtime verification rejects missing and unexpected executable runtime files', t => {
  const { root, metadata } = fixture(t);
  writeFileSync(path.join(root, 'injected.js'), 'unexpected');
  assert.throws(() => verifyRuntime(metadata, root), /Unexpected runtime file/);
  rmSync(path.join(root, 'injected.js')); rmSync(path.join(root, 'utils/storeTarget.js'));
  assert.throws(() => verifyRuntime(metadata, root), /Missing runtime file/);
});
