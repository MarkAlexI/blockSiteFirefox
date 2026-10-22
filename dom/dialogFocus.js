const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

function canFocus(element) {
  return element?.isConnected && element.matches(FOCUSABLE) &&
    !element.matches(':disabled') && !element.closest('[hidden], .hidden, [inert]') &&
    element.getClientRects().length > 0;
}

// Native showModal() makes the background inert. Wrap the document's Tab
// sequence at its ends, using the current controls after each draft edit.
export function keepDialogFocus(event, dialog) {
  if (event.key !== 'Tab' || event.defaultPrevented || !dialog.open ||
      event.target.closest('dialog') !== dialog) return;
  const controls = [...dialog.querySelectorAll(FOCUSABLE)]
    .filter(element => canFocus(element) && element.tabIndex >= 0);
  const first = controls[0];
  const last = controls.at(-1);
  const active = dialog.ownerDocument.activeElement;
  if (!first) return;
  if (event.shiftKey && (active === first || !controls.includes(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !controls.includes(active))) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreDialogFocus(...candidates) {
  for (const element of candidates) {
    if (!canFocus(element)) continue;
    element.focus();
    if (element.ownerDocument.activeElement === element) return;
  }
}
