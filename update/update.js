document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "🛡️ Reliable Permissions: Host access is checked by the existing minute alarm and permission change events without waking the worker on every tab switch.",
    "🩺 Diagnostics for Everyone: Every user can generate, copy, and export a privacy-safe current-state report.",
    "🔍 Pro Event History: Detailed recent events remain available through Pro Debug Mode.",
    "🧹 Clear History Fixed: Clearing diagnostic history no longer triggers an Illegal invocation error."
  ];
  
  const ul = document.getElementById('features');
  features.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.append(li);
  });
  
  const closeBtn = document.getElementById('close-btn');
  
  closeBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({
      type: 'close_current_tab'
    });
  });
});