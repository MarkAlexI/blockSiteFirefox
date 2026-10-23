const notifications = new WeakMap();

function createNotifications(document) {
  let region = document.getElementById('custom-alert');
  if (!region) {
    region = document.createElement('div');
    region.id = 'custom-alert';
    document.body.appendChild(region);
  }
  region.classList.add('custom-alert');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.setAttribute('dir', 'auto');

  const queue = [];
  let current = null;
  let timer = null;
  let epoch = 0;
  let hovered = false;
  let disposed = false;
  const blocked = () => document.hidden || !!document.querySelector('dialog[open]');
  const clear = () => {
    if (region.textContent) region.textContent = '';
    region.removeAttribute('tabindex');
  };
  const cancel = () => {
    epoch++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const later = (callback, delay) => {
    cancel();
    const scheduledEpoch = epoch;
    timer = setTimeout(() => {
      if (disposed || scheduledEpoch !== epoch) return;
      timer = null;
      callback();
    }, delay);
  };
  const expire = () => {
    if (current === null || hovered || document.activeElement === region) return;
    // At least five seconds; allow more reading time for long translations.
    later(() => {
      current = null;
      clear();
      advance();
    }, Math.max(5_000, Array.from(current).length * 50));
  };
  const advance = () => {
    if (disposed) return;
    // A body-level status is inert under showModal(). Retain it for after close.
    if (blocked()) {
      cancel();
      if (current !== null) queue.unshift(current);
      current = null;
      hovered = false;
      clear();
      return;
    }
    if (current !== null) { if (timer === null) expire(); return; }
    if (timer !== null || queue.length === 0) return;
    // Keep the empty live region mounted before changing its text. The gap also
    // makes consecutive identical messages separate accessibility updates.
    later(() => {
      if (blocked()) { advance(); return; }
      current = queue.shift();
      region.textContent = current;
      // Keyboard users can read/scroll a long notice and pause its expiry.
      region.setAttribute('tabindex', '0');
      expire();
    }, 100);
  };
  const pause = () => { hovered = true; if (current !== null) cancel(); };
  const resume = () => { hovered = false; expire(); };
  region.addEventListener('pointerenter', pause);
  region.addEventListener('pointerleave', resume);
  region.addEventListener('focus', cancel);
  document.addEventListener('visibilitychange', advance);
  document.addEventListener('focusin', advance);
  document.addEventListener('close', advance, true);
  const view = document.defaultView;
  // Also cover dialogs opened without moving focus, or removed while open.
  const observer = view?.MutationObserver ? new view.MutationObserver(advance) : null;
  observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  const dispose = () => {
    disposed = true;
    cancel();
    queue.length = 0;
    current = null;
    clear();
    observer?.disconnect();
    region.removeEventListener('pointerenter', pause);
    region.removeEventListener('pointerleave', resume);
    region.removeEventListener('focus', cancel);
    document.removeEventListener('visibilitychange', advance);
    document.removeEventListener('focusin', advance);
    document.removeEventListener('close', advance, true);
    view?.removeEventListener('pagehide', dispose);
    notifications.delete(document);
  };
  view?.addEventListener('pagehide', dispose);
  return message => { queue.push(message); advance(); };
}

export function customAlert(message) {
  const text = String(message ?? '').trim();
  if (!text || !document.body) return;
  if (!notifications.has(document)) notifications.set(document, createNotifications(document));
  notifications.get(document)(text);
}
