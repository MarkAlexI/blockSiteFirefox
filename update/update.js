document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "Daily Limits start when you return to a tracked site from Settings, and pause when the page is hidden.",
    "Switching a disabled Always rule to a Daily Limit or schedule now applies the selected mode.",
    "Rule changes on Firefox for Android close matching tabs without opening extra blank tabs."
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