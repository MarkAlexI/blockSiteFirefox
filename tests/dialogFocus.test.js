import test from 'node:test';
import assert from 'node:assert/strict';
import { keepDialogFocus, restoreDialogFocus } from '../dom/dialogFocus.js';
import { DialogTestDocument } from './helpers/dialogTestDocument.js';

test('dialog Tab boundaries skip unavailable controls and update after dynamic edits', async () => {
  const document = new DialogTestDocument();
  const dialog = document.addElement('dialog', 'dialog');
  const controls = ['first', 'disabled', 'hidden', 'last'].map(id => document.addElement(id, 'button'));
  dialog.append(...controls);
  controls[1].disabled = true;
  controls[2].hidden = true;
  dialog.showModal();
  controls[0].focus();
  const key = (target, shiftKey) => ({ key: 'Tab', target, shiftKey,
    preventDefault() { this.defaultPrevented = true; } });
  let event = key(controls[0], true);
  keepDialogFocus(event, dialog);
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement.id, 'last');
  controls[3].remove();
  controls[0].focus();
  event = key(controls[0], false);
  keepDialogFocus(event, dialog);
  assert.equal(document.activeElement.id, 'first');
  assert.equal(event.defaultPrevented, true);
});

test('a parent dialog does not handle Tab from a nested dialog', () => {
  const document = new DialogTestDocument();
  const parent = document.addElement('parent', 'dialog');
  const child = document.addElement('child', 'dialog');
  const button = document.addElement('nested-action', 'button');
  parent.appendChild(child); child.appendChild(button);
  parent.showModal(); child.showModal(); button.focus();
  keepDialogFocus({ key: 'Tab', target: button, preventDefault() { assert.fail('Parent trapped child Tab'); } }, parent);
  assert.equal(document.activeElement.id, 'nested-action');
});

test('focus return uses an available fallback after the original action disappears or becomes hidden', () => {
  const document = new DialogTestDocument();
  const removed = document.addElement('removed', 'button');
  const hidden = document.addElement('hidden', 'button');
  const fallback = document.addElement('fallback', 'button');
  removed.remove(); hidden.hidden = true;
  restoreDialogFocus(removed, hidden, fallback);
  assert.equal(document.activeElement.id, 'fallback');
});
