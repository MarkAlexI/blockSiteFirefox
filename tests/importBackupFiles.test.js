import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, stat, utimes, readdir, unlink, rmdir } from 'node:fs/promises';

// Load the real helper method without importing the browser runner/dependencies.
const fixture = await readFile(new URL('../e2e/fixtures.mjs', import.meta.url), 'utf8');
const method = fixture.match(/^  async importBackup\([\s\S]*?^  }/m)?.[0];
assert.ok(method, 'the production E2E upload helper exists');

async function withFiles(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bd-import-files-'));
  const events = [], selected = [], writes = [];
  let writeError = null;
  const helper = vm.runInNewContext(`({${method}})`, {
    path,
    writeFile: async (filename, contents) => {
      events.push('write'); writes.push({ filename, contents });
      if (writeError) throw writeError;
      await writeFile(filename, contents);
    }
  });
  helper.profile = helper.root = directory;
  const select = async filename => {
    await readFile(filename); // Missing files cannot masquerade as an upload.
    events.push('select'); selected.push(filename);
  };
  const page = {
    async bringToFront() { events.push('front'); },
    locator(selector) { assert.equal(selector, '#importFileInput'); return { setInputFiles: select }; },
    async element(selector) { assert.equal(selector, '#importFileInput'); return { sendKeys: select }; }
  };
  try { await run({ helper, page, directory, events, selected, writes, failWrites: error => { writeError = error; } }); }
  finally {
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  }
}

test('the default backup upload writes complete JSON before selecting its real file', async () => {
  await withFiles(async ({ helper, page, directory, events, selected }) => {
    const backup = { rules: [{ blockURL: 'first.example' }] };
    await helper.importBackup(page, backup);
    const filename = path.join(directory, 'reader-backup.json');
    assert.deepEqual(selected, [filename]);
    assert.equal(await readFile(filename, 'utf8'), JSON.stringify(backup));
    assert.equal(events[0], 'write'); assert.equal(events.at(-1), 'select');
    if (fixture.includes('page.bringToFront()')) assert.deepEqual(events, ['write', 'front', 'select']);
  });
});

test('different backups retain distinct paths and cannot overwrite a previously selected file', async () => {
  await withFiles(async ({ helper, page, directory, selected }) => {
    const first = { rules: [{ blockURL: 'first.example' }] }, later = { rules: [{ blockURL: 'later.example' }] };
    await helper.importBackup(page, first, { filename: 'first-backup.json' });
    await helper.importBackup(page, later, { filename: 'later-backup.json' });
    assert.deepEqual(selected, [path.join(directory, 'first-backup.json'), path.join(directory, 'later-backup.json')]);
    assert.equal(await readFile(selected[0], 'utf8'), JSON.stringify(first));
    assert.equal(await readFile(selected[1], 'utf8'), JSON.stringify(later));
  });
});

test('an explicit same-file retry preserves its path, bytes and modification time without a second write', async () => {
  await withFiles(async ({ helper, page, directory, selected, writes }) => {
    await helper.importBackup(page, { rules: [] }, { filename: 'later-backup.json' });
    const filename = path.join(directory, 'later-backup.json');
    const fixedTime = new Date('2001-01-01T00:00:00.000Z');
    await utimes(filename, fixedTime, fixedTime);
    const contents = await readFile(filename), before = await stat(filename);
    await helper.importBackup(page, undefined, { filename: 'later-backup.json', reuse: true });
    assert.deepEqual(selected, [filename, filename]);
    assert.equal(writes.length, 1);
    assert.deepEqual(await readFile(filename), contents);
    assert.equal((await stat(filename)).mtimeMs, before.mtimeMs);
  });
});

test('a failed file write rejects without attempting a native selection', async () => {
  await withFiles(async ({ helper, page, events, selected, failWrites }) => {
    const failure = new Error('test fixture write unavailable'); failWrites(failure);
    await assert.rejects(helper.importBackup(page, { rules: [] }, { filename: 'failed-backup.json' }), error => error === failure);
    assert.deepEqual(events, ['write']); assert.deepEqual(selected, []);
  });
});
