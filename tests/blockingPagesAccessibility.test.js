import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { installClosePageProbe } from '../e2e/blocking-page-scenarios.mjs';
import { IS_FIREFOX } from '../utils/constants.js';
import { FakeDocument } from './helpers/extensionTestHarness.js';

const source = readFileSync(new URL('../scripts/blocked.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const settle = () => new Promise(resolve => setImmediate(resolve));
const hold = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function mount({ close = async () => ({ success: true }), tab = async () => ({ id: 73 }), reason = 'daily_limit' } = {}) {
  const document = new FakeDocument();
  const button = document.addElement('closeBtn', 'button');
  const status = document.addElement('closeStatus', 'p');
  const explanation = document.addElement('blockedReason', 'p');
  explanation.setAttribute('data-i18n', 'blockedtext');
  const other = document.addElement('later-choice', 'a'); button.focus();
  const listeners = new Map(), removed = [], messages = [];
  const api = { runtime: { sendMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); return close(); } },
    tabs: { getCurrent: tab, remove(id) { removed.push(id); return close(); } } };
  const window = { location: { href: 'https://extension.example/blocked.html?reason=' + encodeURIComponent(reason) },
    addEventListener(type, listener) { listeners.set(type, listener); } };
  vm.runInNewContext(source, { document, window, chrome: api, browser: api, URL,
    t: key => ({ blockedclosepending: 'Closing test tab', blockedclosefailed: 'Close failed. Retry explicitly.' }[key] || key) });
  return { document, button, status, other, explanation, removed, messages, hide() { listeners.get('pagehide')?.(); }, show() { listeners.get('pageshow')?.({ persisted: true }); } };
}

test('blocked close keeps one request pending, retains focus and waits for the browser result', async () => {
  const request = hold();
  const page = mount({ close: () => request.promise });
  await page.button.dispatch('click'); await settle();
  await page.button.dispatch('click'); await settle();
  assert.equal(page.status.textContent, 'Closing test tab');
  assert.equal(page.button.getAttribute('aria-disabled'), 'true');
  assert.equal(page.button.disabled, false);
  assert.equal(page.document.activeElement, page.button);
  assert.deepEqual(IS_FIREFOX ? page.messages : page.removed, IS_FIREFOX ? [{ type: 'close_current_tab' }] : [73]);
  request.resolve({ success: true }); await settle();
  assert.equal(page.button.getAttribute('aria-disabled'), 'false');
  assert.equal(page.status.textContent, '');
});

test('blocked close reports rejection without raw details, keeps later focus and retries only on a new action', async () => {
  let calls = 0;
  const request = hold();
  const page = mount({ close: () => ++calls === 1 ? request.promise : Promise.resolve({ success: true }) });
  await page.button.dispatch('click'); await settle(); page.other.focus();
  request.reject(new Error('private.example secret key')); await settle();
  assert.equal(page.status.textContent, 'Close failed. Retry explicitly.');
  assert.equal(page.button.getAttribute('aria-disabled'), 'false');
  assert.equal(page.document.activeElement, page.other);
  await settle(); assert.equal(calls, 1);
  await page.button.dispatch('click'); await settle(); assert.equal(calls, 2);
});

test('blocked close turns a synchronous browser API exception into safe persistent feedback', async () => {
  const page = mount({ close: () => { throw new Error('private native error'); } });
  await page.button.dispatch('click'); await settle();
  assert.equal(page.status.textContent, 'Close failed. Retry explicitly.');
  assert.equal(page.button.getAttribute('aria-disabled'), 'false');
});

test('close validation requires a positive Firefox reply or a valid current Chromium tab', async () => {
  if (IS_FIREFOX) {
    for (const result of [undefined, null, {}, { success: false }, { success: 'true' }]) {
      const page = mount({ close: async () => result });
      await page.button.dispatch('click'); await settle();
      assert.equal(page.status.textContent, 'Close failed. Retry explicitly.');
    }
  } else {
    const zero = mount({ tab: async () => ({ id: 0 }) });
    await zero.button.dispatch('click'); await settle(); assert.deepEqual(zero.removed, [0]);
    for (const tab of [undefined, {}, { id: -1 }, { id: '73' }]) {
      const page = mount({ tab: async () => tab });
      await page.button.dispatch('click'); await settle();
      assert.deepEqual(page.removed, []); assert.equal(page.status.textContent, 'Close failed. Retry explicitly.');
    }
  }
});

test('pagehide prevents late feedback or replay after an outstanding close request', async () => {
  const request = hold(); const page = mount({ close: () => request.promise });
  await page.button.dispatch('click'); await settle();
  const shown = page.status.textContent; page.hide();
  request.reject(new Error('late rejection')); await settle();
  assert.equal(page.status.textContent, shown);
  await page.button.dispatch('click'); await settle();
  assert.equal((IS_FIREFOX ? page.messages : page.removed).length, 1);
});

test('held activation keys do not replay close actions, while initial Enter and Space stay native', async () => {
  const page = mount();
  for (const key of ['Enter', ' ']) {
    assert.equal((await page.button.dispatch('keydown', { key, repeat: true })).defaultPrevented, true);
    assert.equal(Boolean((await page.button.dispatch('keydown', { key, repeat: false })).defaultPrevented), false);
  }
});

test('blocked reason lookup accepts only the four own allowlisted names', () => {
  for (const [reason, key] of Object.entries({ always: 'blocking_mode_always', schedule: 'rule_scheduled', daily_limit: 'daily_limit_reached', focus: 'focussessionheader' })) {
    const page = mount({ reason }); assert.equal(page.explanation.getAttribute('data-i18n'), key);
    assert.equal(page.explanation.textContent, key);
  }
  for (const reason of ['unknown', '__proto__', 'constructor', 'toString', '<b>private</b>']) {
    assert.equal(mount({ reason }).explanation.getAttribute('data-i18n'), 'blockedtext');
  }
});

test('both full-page screens expose a main landmark, and close feedback stays mounted outside the button', () => {
  const blocked = readFileSync(new URL('../blocked.html', import.meta.url), 'utf8');
  const redirect = readFileSync(new URL('../redirect.html', import.meta.url), 'utf8');
  assert.match(blocked, /<main\b[^>]*aria-labelledby="blockedHeading"/);
  assert.match(blocked, /id="closeStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*><\/p>/);
  assert.match(redirect, /<main\b/);
  assert.match(redirect, /class="loader"[^>]*aria-hidden="true"/);
});

test('every shipping locale has the redirect and close-action messages', () => {
  const locales = readdirSync(new URL('../_locales/', import.meta.url));
  assert.equal(locales.length, 57);
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
    for (const key of ['redirecttitle', 'redirectpending', 'blockedclosepending', 'blockedclosefailed']) {
      assert.equal(typeof messages[key]?.message, 'string', `${locale}: ${key}`);
      assert.ok(messages[key].message.trim().length > 0, `${locale}: ${key}`);
    }
  }
});

test('return from page cache resets the action and rejects an older operation result', async () => {
  const old = hold(); let calls = 0;
  const page = mount({ close: () => ++calls === 1 ? old.promise : Promise.resolve({ success: true }) });
  await page.button.dispatch('click'); await settle(); page.hide(); page.show();
  assert.equal(page.button.getAttribute('aria-disabled'), 'false');
  await page.button.dispatch('click'); await settle(); assert.equal(calls, 2);
  old.reject(new Error('stale failure')); await settle(); assert.equal(page.status.textContent, '');
});

test('the native UI fault probe keeps Chrome on tabs.getCurrent even when browser.* also exists', async () => {
  let untouchedCalls = 0;
  const original = () => { untouchedCalls += 1; return Promise.resolve({ id: 7 }); };
  const chrome = { tabs: { getCurrent: original }, runtime: { sendMessage: original } };
  const browser = { tabs: { getCurrent: original }, runtime: { sendMessage: original } };
  const window = {};
  vm.runInNewContext(`(${installClosePageProbe.toString()})({ firefox: false })`, { chrome, browser, window });
  const response = chrome.tabs.getCurrent().catch(() => {});
  assert.equal(window.__bdClosePageProbe.calls, 1); assert.equal(untouchedCalls, 0);
  assert.equal(chrome.runtime.sendMessage, original); assert.equal(browser.runtime.sendMessage, original);
  window.__bdClosePageProbe.reject(new Error('controlled rejection')); await response;
});
