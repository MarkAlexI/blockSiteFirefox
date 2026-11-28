import test from 'node:test';
import assert from 'node:assert/strict';
import { readDnrDocument } from '../e2e/dnr-document-observation.mjs';

const transition = "script.evaluate: unknown error: AbortError: Actor 'MessageHandlerFrame' destroyed before query 'MessageHandlerFrameParent:sendCommand' was resolved";

test('a DNR observation returns URL and document identity from the same successful native read', async () => {
  const document = { url: 'moz-extension://own/blocked.html', documentOrigin: 1234 };
  assert.equal(await readDnrDocument(async () => document), document);
});

test('only the observed Firefox frame-actor transition is pending, and the next read must prove the document', async () => {
  assert.equal(await readDnrDocument(async () => { throw Error(transition); }), null);
  const document = { url: 'moz-extension://own/blocked.html', documentOrigin: 1235 };
  assert.equal(await readDnrDocument(async () => document), document);
});

test('script errors and unrelated protocol failures cannot pass as DNR readiness', async () => {
  for (const message of ['script.evaluate: JavaScript exception', 'unknown browsing context', 'connection refused', 'AbortError']) {
    const error = Error(message);
    await assert.rejects(readDnrDocument(async () => { throw error; }), value => value === error);
  }
});
