// Action feedback has one polite channel. Keep only the latest result: a rapid
// Undo must not be followed by a delayed announcement that the session is skipped.
export function createFocusScheduleAnnouncer(document) {
  let region = document.querySelector('[data-focus-announcer]');
  if (!region) {
    // Retained pre-update documents may not have the new markup yet.
    region = document.createElement('p');
    region.setAttribute('data-focus-announcer', '');
    document.body.appendChild(region);
  }
  region.classList.add('dialog-announcement');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.setAttribute('dir', 'auto');

  let pending = null;
  let timer = null;
  let epoch = 0;
  let disposed = false;
  const blocked = () => document.hidden || !!document.querySelector('dialog[open]');
  const empty = () => { if (region.textContent) region.textContent = ''; };
  const cancelTimer = () => {
    epoch++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const clear = () => { cancelTimer();pending = null;empty(); };
  const advance = () => {
    if (disposed || pending === null) return;
    // Body-level statuses are inert while a modal is open. Retain the latest
    // result until the document is visible and outside the modal context again.
    if (blocked()) { cancelTimer();empty();return; }
    if (timer !== null) return;
    const scheduledEpoch = epoch;
    timer = setTimeout(() => {
      if (disposed || scheduledEpoch !== epoch) return;
      timer = null;
      if (blocked()) { advance();return; }
      region.textContent = pending;
      pending = null;
    }, 100);
  };
  const announce = message => {
    if (disposed) return;
    clear();
    pending = String(message ?? '').trim() || null;
    // The empty mounted region and a separate task allow repeated identical
    // errors to be announced without recreating nodes or moving keyboard focus.
    advance();
  };
  document.addEventListener('visibilitychange', advance);
  document.addEventListener('focusin', advance);
  document.addEventListener('close', advance, true);
  const view = document.defaultView;
  const observer = view?.MutationObserver ? new view.MutationObserver(advance) : null;
  observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  const dispose = () => {
    disposed = true;
    clear();
    observer?.disconnect();
    document.removeEventListener('visibilitychange', advance);
    document.removeEventListener('focusin', advance);
    document.removeEventListener('close', advance, true);
    view?.removeEventListener('pagehide', dispose);
  };
  view?.addEventListener('pagehide', dispose);
  return { announce, clear };
}
