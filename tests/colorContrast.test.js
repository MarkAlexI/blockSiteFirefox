import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPalette, contrastRatio } from '../tools/check-contrast.js';
const css = readFileSync(new URL('../styles/common.css', import.meta.url), 'utf8');

test('the release palette meets text and control contrast including gradient stops and unblurred glass', () => {
  const checks = checkPalette(css);
  assert.ok(checks.length > 60);
  assert.ok(checks.every(item => item.ratio >= item.minimum));
  assert.equal(contrastRatio([0,0,0], [255,255,255]), 21);
  assert.equal(contrastRatio([255,255,255], [255,255,255]), 1);
});

test('faint helper text, light buttons and invisible control borders fail the palette guard', () => {
  for (const [name, value] of [['muted','#9ca3af'],['success','#28a745'],['danger','#ff4d4d'],['control-border','#dddddd'],['accent-gold','#5b4b00']]) {
    assert.throws(() => checkPalette(css.replace(new RegExp(`(--bd-${name}: )#[\\da-f]{6};`), '$1' + value + ';')), /below/);
  }
});

test('a light gradient stop or a glass layer that depends on blur cannot pass the guard', () => {
  assert.throws(() => checkPalette(css.replace('#315aa8', '#aabbff')), /gradient.*below/);
  assert.throws(() => checkPalette(css.replace('/ 96%', '/ 40%')), /glass.*below/);
  assert.throws(() => checkPalette(css.replace('--bd-muted:', '--removed-muted:')), /Missing palette color/);
});
