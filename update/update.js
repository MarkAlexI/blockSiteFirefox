document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "✨ A familiar look, with more clarity. Richer blues, deeper greens and clearer text make your everyday controls easier to read.",
    "🧊 A lighter touch of glass. Settings keep a soft, layered look, with a solid fallback that stays readable without blur.",
    "⌨️ Follow your focus. Clearer keyboard outlines help you see which control is ready for your next action.",
    "🌿 Your routines stay yours. Your saved rules, schedules and Pro access carry on as before."
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