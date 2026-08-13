const closeBtn = document.getElementById('closeBtn');

closeBtn.addEventListener('click', () => {
  try {
    const request = browser.runtime.sendMessage({
      type: 'close_current_tab'
    });
    if (request && typeof request.catch === 'function') {
      request.catch(() => {});
    }
  } catch {
    // The page can remain open if the background page is unavailable.
  }
});