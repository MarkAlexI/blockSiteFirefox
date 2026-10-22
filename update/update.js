document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "⌨️ Navigate Settings with your keyboard. Expand sections with Enter or Space and move through their controls with Tab.",
    "🔎 Clearer names for controls. Rule categories, blocking modes and search fields are easier to identify with assistive technology.",
    "⬆️ Return to the top. A named scroll button brings you back to a visible action, with a clear keyboard focus.",
    "💾 Keep your entries. Collapsing a Settings section preserves your unsaved entries when you open it again."
  ];
  
  const ul = document.getElementById('features');
  features.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.append(li);
  });
  
  document.getElementById('privacy-settings-btn')?.addEventListener('click', async () => {
    if (typeof browser.runtime.openOptionsPage === 'function') {
      try {
        await browser.runtime.openOptionsPage();
        return;
      } catch {
        // Fall back to opening the packaged Options page directly.
      }
    }

    try {
      await browser.tabs.create({
        url: browser.runtime.getURL('options/options.html')
      });
    } catch {
      // The update page can remain open if the browser cannot create the tab.
    }
  });

  const closeBtn = document.getElementById('close-btn');
  
  closeBtn.addEventListener('click', () => {
    try {
      const request = browser.runtime.sendMessage({
        type: 'close_current_tab'
      });
      if (request && typeof request.catch === 'function') {
        request.catch(() => {});
      }
    } catch {
      // The update page can remain open if the background page is unavailable.
    }
  });
});