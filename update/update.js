document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "🔓 Memory Limits Removed: We 've switched to local storage. Create 1000+ rules (Pro) without any risk of performance drops or crashes!",
    "📦 Safe Migration: All your settings and existing rules have been successfully and automatically migrated.",
    "⚠️ Sync Changes: Automatic background rule synchronization is no longer supported. Please use the Export / Import buttons(Pro) to manually transfer your rules between devices. General extension preferences will continue to sync automatically.",
    "📱 Mobile Stability: Fixed background processes and timers on Firefox Mobile, and greatly improved UI responsiveness when switching tabs rapidly."
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