// Read-only DOM observation, serialized by either Playwright or Firefox BiDi.
// A visible Stop can belong to a Start whose acknowledgement is still pending.
export function readFocusActionReadiness(kind) {
  if (!['start', 'stop'].includes(kind)) throw new Error('Unknown Focus action');
  const controls = document.getElementById('focus-controls');
  const view = document.getElementById(kind === 'start' ? 'focus-start-view' : 'focus-active-view');
  const button = document.getElementById(`${kind}-focus-btn`);
  const busy = controls?.getAttribute('aria-busy') === 'true';
  const guarded = button?.getAttribute('aria-disabled') === 'true';
  const visible = Boolean(view && button && !view.hidden && !view.classList.contains('hidden') &&
    !button.hidden && !button.classList.contains('hidden') && button.getClientRects().length);
  return { kind, busy, guarded, visible, disabled: button?.disabled ?? true,
    ready: Boolean(controls && visible && !busy && !guarded && !button.disabled) };
}
