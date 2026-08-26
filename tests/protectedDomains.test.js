import test from 'node:test';
import assert from 'node:assert/strict';

import { IS_FIREFOX } from '../utils/constants.js';
import {
  getProtectedRequestDomains,
  isProtectedRequestHostname
} from '../utils/protectedDomains.js';
import { RulesManager } from '../rules/rulesManager.js';
import { doesUrlMatchBlockRule } from '../rules/urlRuleMatcher.js';
import { isBlockedURL } from '../scripts/isBlockedURL.js';

test('protected request domains contain precise Google OAuth and project hosts', () => {
  const domains = getProtectedRequestDomains();

  for (const domain of [
    'accounts.google.com',
    'accounts.youtube.com',
    'blockdistraction.com',
    'ext.pp.ua',
    'markdigital.cc'
  ]) {
    assert.equal(domains.includes(domain), true, domain);
  }

  assert.equal(new Set(domains).size, domains.length);
  assert.equal(domains.every(domain => /^[a-z0-9.-]+$/.test(domain)), true);
  assert.equal(domains.includes('youtube.com'), false);
  assert.equal(domains.includes('google.com'), false);
});

test('protected request hosts include real subdomains without trusting lookalikes', () => {
  for (const hostname of [
    'accounts.google.com',
    'nested.accounts.google.com',
    'ACCOUNTS.YOUTUBE.COM',
    'support.blockdistraction.com',
    'markdigital.cc'
  ]) {
    assert.equal(isProtectedRequestHostname(hostname), true, hostname);
  }

  for (const hostname of [
    'youtube.com',
    'm.youtube.com',
    'google.com',
    'news.google.com',
    'notaccounts.youtube.com',
    'accounts.youtube.com.evil.example',
    'blockdistraction.com.evil.example',
    'markdigital.com',
    'support.markdigital.com',
    '',
    null
  ]) {
    assert.equal(isProtectedRequestHostname(hostname), false, String(hostname));
  }
});

test('store request protection remains specific to the current browser target', () => {
  const domains = getProtectedRequestDomains();

  if (IS_FIREFOX) {
    assert.equal(domains.includes('addons.mozilla.org'), true);
    assert.equal(domains.includes('chromewebstore.google.com'), false);
    return;
  }

  assert.equal(domains.includes('chromewebstore.google.com'), true);
  assert.equal(domains.includes('chrome.google.com'), true);
  assert.equal(domains.includes('bing.com'), false);
  assert.equal(domains.includes('microsoft.com'), false);

  const edgeDomains = getProtectedRequestDomains({ buildTarget: 'edge' });
  assert.equal(edgeDomains.includes('bing.com'), true);
  assert.equal(edgeDomains.includes('microsoft.com'), true);
  assert.equal(edgeDomains.includes('microsoftedge.microsoft.com'), true);
  assert.equal(isProtectedRequestHostname('www.bing.com', { buildTarget: 'edge' }), true);
  assert.equal(isProtectedRequestHostname('www.bing.com', { buildTarget: 'chrome' }), false);
});

test('blacklist validation rejects direct OAuth hosts but preserves useful partial targets', () => {
  const manager = new RulesManager();

  for (const target of [
    'accounts.google.com',
    'accounts.youtube.com',
    'accounts.google.com:443',
    'accounts.youtube.com:8443/accounts/SetSID',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'accounts.youtube.com/accounts/SetSID',
    'support.blockdistraction.com'
  ]) {
    const validation = manager.validateRule(target, '', null, 'social');
    assert.equal(validation.errors.includes('blockurl_restrict'), true, target);
  }

  for (const target of [
    'yout',
    'yo',
    'youtube.com',
    'goog',
    'google.com',
    'block',
    'markdigital',
    'markdigital.com'
  ]) {
    assert.equal(manager.validateRule(target, '', null, 'social').isValid, true, target);
  }
});

test('OAuth and project host protection cannot be spoofed by unrelated URL text', () => {
  for (const url of [
    'https://evil.example/?next=accounts.google.com',
    'https://evil.example/accounts.youtube.com',
    'https://accounts.youtube.com.evil.example/',
    'https://accounts.google.com@evil.example/'
  ]) {
    assert.equal(isBlockedURL([{ url }]), false, url);
  }

  assert.equal(doesUrlMatchBlockRule('https://accounts.youtube.com/accounts/SetSID', 'yout'), false);
  assert.equal(doesUrlMatchBlockRule('https://accounts.google.com/o/oauth2/v2/auth', 'goog'), false);
  assert.equal(doesUrlMatchBlockRule('https://blockdistraction.com/login.html', 'block'), false);
  assert.equal(doesUrlMatchBlockRule('https://markdigital.cc/', 'markdigital'), false);
  assert.equal(doesUrlMatchBlockRule('https://markdigital.com/', 'markdigital'), true);
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/watch?v=1', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://www.google.com/search?q=test', 'goog'), true);
  assert.equal(doesUrlMatchBlockRule('https://blockparty.example/', 'block'), true);
});
