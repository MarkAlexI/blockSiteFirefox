import test from 'node:test';
import assert from 'node:assert/strict';
import { popupFocusFixture } from './helpers/popupFocusFixture.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

for (const outcome of ['success', 'rejection', 'transport_failure']) {
  test(`Pomodoro buttons and busy state settle after a ${outcome} Start reply`, async () => {
    await withExtensionEnvironment(createExtensionApi(), async () => {
      const { PomodoroUI } = await import('../utils/pomodoroUI.js');
      const f = popupFocusFixture();
      const ui = Object.assign(Object.create(PomodoroUI.prototype), {
        popup: f.c,
        panel: f.document.addElement('pomodoro-panel'),
        next: f.document.addElement('pomodoro-next', 'button'),
        stop: f.document.addElement('pomodoro-stop', 'button'),
        recoverIfNeeded: async () => {},
        // Rendering calls the production pending-state method while Focus owns the action.
        render: async () => ui.syncActions()
    });
    f.c.pomodoro = ui;
    await f.ready();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.send(async () => {
      await gate;
      if (outcome === 'transport_failure') throw new Error('synthetic transport failure');
      return { success: outcome === 'success' };
    });
    const starting = f.c.runFocusAction('start', { type: 'start_pomodoro', config: {} });
    try {
      await f.c.updateFocusUI();
      assert.equal(ui.panel.getAttribute('aria-busy'), 'true');
      assert.equal(ui.stop.disabled, true);
    } finally { release(); }
    await starting;
    assert.equal(f.fields.focusControls.getAttribute('aria-busy'), null);
    assert.equal(ui.panel.getAttribute('aria-busy'), null);
    assert.equal(ui.next.disabled, false);
    assert.equal(ui.stop.disabled, false);
    });
  });
}
