import assert from 'node:assert/strict';
async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const focus = (page, selector) => page.evaluate(selector => document.querySelector(selector).focus(), selector);

export const accessibilityScenarios = [{
  id: '48',
  title: 'Options disclosures and named rule controls support native keyboard input and hidden panels leave Tab order',
  async run(e) {
    const page = await e.openOptions();
    const panels = await page.evaluate(() => [...document.querySelectorAll('.collapsible-toggle')]
      .map(button => button.getAttribute('aria-controls')));
    assert.equal(panels.length, 7);
    for (const [index, id] of panels.entries()) {
      const selector = `.collapsible-toggle[aria-controls="${id}"]`;
      const expanded = index >= 5;
      assert.equal(await page.evaluate(id => document.getElementById(id).hidden, id), !expanded);
      await focus(page, selector);
      if (expanded) await press(page, 'Space');
      await press(page, 'Enter');
      assert.equal(await page.evaluate(id => document.getElementById(id).hidden, id), false);
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), selector), 'true');
      await press(page, 'Tab');
      assert.equal(await page.evaluate(id => document.getElementById(id).contains(document.activeElement), id), true,
        `${id}: Tab reaches an expanded panel control`);
      await press(page, 'Shift+Tab');
      assert.equal(await page.evaluate(selector => document.activeElement.matches(selector), selector), true);
      await press(page, 'Space');
      assert.equal(await page.evaluate(id => document.getElementById(id).hidden, id), true);
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), selector), 'false');
      await press(page, 'Tab');
      assert.equal(await page.evaluate(id => document.getElementById(id).contains(document.activeElement), id), false,
        `${id}: collapsed panel leaves Tab order`);
    }

    // A draft survives closing the Rule Lists panel; no create/save mutation.
    await focus(page, '[aria-controls="rule-lists-panel"]');
    await press(page, 'Enter');
    if (page.locator) await page.locator('#rule-list-name-input').fill('KeyboardDraft');
    else await page.fill('#rule-list-name-input', 'KeyboardDraft');
    await focus(page, '[aria-controls="rule-lists-panel"]');
    await press(page, 'Space');
    await press(page, 'Enter');
    assert.equal(await page.evaluate(() => document.getElementById('rule-list-name-input').value), 'KeyboardDraft');
    await focus(page, '#add-rule');
    await press(page, 'Enter');
    await poll(() => page.evaluate(() => !!document.querySelector('#rules-container .blocking-mode-select')), Boolean, 'named rule editor');
    const labels = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const row = document.querySelector('#rules-container tr:has(.save-btn)');
      return { category: row.querySelector('td:nth-child(3) select').getAttribute('aria-label'),
        mode: row.querySelector('.blocking-mode-select').getAttribute('aria-label'),
        expected: [api.i18n.getMessage('category_header'), api.i18n.getMessage('blockingmode_header')] };
    });
    assert.deepEqual([labels.category, labels.mode], labels.expected);
    if (page.getByRole) {
      for (const name of labels.expected) assert.equal(await page.locator('#rules-container tr:has(.save-btn)').getByRole('combobox', { name, exact: true }).count(), 1);
    } else {
      assert.equal(await (await page.element('#rules-container tr:has(.save-btn) td:nth-child(3) select')).getAccessibleName(), labels.category);
      assert.equal(await (await page.element('#rules-container .blocking-mode-select')).getAccessibleName(), labels.mode);
    }

    const popup = await e.openPopup();
    if (popup.front) await popup.front(); else await popup.bringToFront();
    await poll(() => popup.evaluate(() => document.body.classList.contains('ready')), Boolean, 'popup ready');
    assert.deepEqual(await popup.evaluate(() => {
      const button = document.getElementById('options-link');
      const scroll = document.getElementById('scrollToTopBtn');
      return [button.tagName, button.type, scroll.hidden, scroll.getAttribute('aria-label').length > 1];
    }), ['BUTTON', 'button', true, true]);
    // Real scroll + observer + trusted keyboard activation, without adding rules.
    await popup.evaluate(() => { document.body.style.minHeight = '2200px'; window.scrollTo(0, 1500); });
    await poll(() => popup.evaluate(() => !document.getElementById('scrollToTopBtn').hidden), Boolean, 'scroll button visible');
    await popup.evaluate(() => {
      window.__bdScrollFocus = [];
      for (const type of ['focusin', 'focusout', 'click']) document.addEventListener(type, event => {
        window.__bdScrollFocus.push({ type, target: event.target.id, trusted: event.isTrusted,
          active: document.activeElement?.id, hidden: document.getElementById('scrollToTopBtn').hidden });
      }, true);
    });
    await focus(popup, '#scrollToTopBtn');
    await press(popup, 'Enter');
    await poll(() => popup.evaluate(() => document.documentElement.scrollTop === 0), Boolean, 'returned to top');
    assert.equal(await popup.evaluate(() => document.activeElement.id), 'options-link',
      JSON.stringify(await popup.evaluate(() => window.__bdScrollFocus)));
    await poll(() => popup.evaluate(() => document.getElementById('scrollToTopBtn').hidden), Boolean, 'scroll button hidden');
  }
}];
