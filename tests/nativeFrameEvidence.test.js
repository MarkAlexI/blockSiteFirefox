import assert from 'node:assert/strict';
import test from 'node:test';
import { frameFixtureHtml, frameUrls } from '../e2e/frame-fixture.mjs';
import { assertFrameTree } from '../e2e/frame-scenarios.mjs';

const urls = frameUrls('fixture-token');
const frame = (role, frameId, parent, children = []) => ({ role, frameId, url: urls[role], referrer: parent,
  top: role === 'main', directChild: role === 'middle', children });
const valid = () => ({ tab: { url: urls.main }, frames: [
  frame('leaf', 19, urls.middle), frame('main', 0, '', [urls.middle]), frame('middle', 7, urls.main, [urls.leaf])
] });

test('frame fixture ignores foreign origins, ports and malformed tokens', () => {
  for (const url of [urls.main.replace('http:', 'https:'), urls.main.replace('.test/', '.test:8000/'),
    urls.main.replace('.test/', '.test.example.org/'), urls.main.replace('fixture-token', '%22%3E%3Cscript%3E'),
    urls.main.replace('/frames/main', '/other')]) assert.equal(frameFixtureHtml(url), null);
});

test('frame evidence accepts browser-dependent child result order and IDs', () => {
  assert.equal(assertFrameTree(valid(), urls).leaf.frameId, 19);
});

test('frame evidence rejects a redirected or missing nested document', () => {
  const value = valid(); value.frames[0].url = 'moz-extension://fixture/blocked.html';
  assert.throws(() => assertFrameTree(value, urls), /leaf document URL/);
  value.frames.pop();
  assert.throws(() => assertFrameTree(value, urls), /three real HTTP documents/);
});

test('frame evidence rejects reused native IDs and a flattened parent relationship', () => {
  const value = valid(); value.frames[0].frameId = 7;
  assert.throws(() => assertFrameTree(value, urls), /frame IDs are distinct/);
  value.frames[0].frameId = 19; value.frames[0].referrer = urls.main;
  assert.throws(() => assertFrameTree(value, urls), /nested parent origin/);
});
