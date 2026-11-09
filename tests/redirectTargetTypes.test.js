import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';

const factory = createDnrRuleFactory(path => 'https://extension.invalid/' + path);

test('Redirect types: malformed saved values use the blocked page without URL coercion', () => {
  for (const redirectURL of [undefined, null, false, true, 0, 42, {}, [], ['https://unexpected.example/'], { toString: null }]) {
    for (const reason of [undefined, 'always', 'schedule', 'daily_limit', 'focus']) {
      const rule = factory(1, 'yout', redirectURL, reason);
      const target = new URL(rule.action.redirect.url);
      assert.equal(rule.condition.urlFilter, '||yout');
      assert.equal(target.origin, 'https://extension.invalid');
      assert.equal(target.pathname, '/blocked.html');
      assert.equal(target.searchParams.get('url'), 'yout');
      assert.equal(target.searchParams.has('to'), false);
      assert.equal(target.searchParams.get('reason'), reason ?? null);
    }
  }
});

test('Redirect types: valid HTTP and HTTPS strings retain their destination and encoded path', () => {
  for (const [value, expected] of [
    ['  HTTP://Example.test:80/target?q=1#section  ', 'http://example.test/target?q=1#section'],
    [' https://example.test/a%2Fb?q=1#section ', 'https://example.test/a%2Fb?q=1#section']
  ]) {
    const rule = factory(1, 'example.test/a%2Fb', value, 'daily_limit');
    const target = new URL(rule.action.redirect.url);
    assert.equal(rule.condition.urlFilter, '||example.test/a%2Fb');
    assert.equal(target.pathname, '/redirect.html');
    assert.equal(target.searchParams.get('to'), expected);
    assert.equal(target.searchParams.get('from'), encodeURIComponent('example.test/a%2Fb'));
    assert.equal(target.searchParams.has('reason'), false);
  }
});
