document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "📦 Rule Packs: Start quickly with reviewed sets for social media, video, news, shopping, and gaming.",
    "👀 Full Preview: See every address and remove anything you do not want before adding the pack.",
    "🛡️ Safe Import: Existing duplicates and whitelist conflicts are skipped without changing your current rules.",
    "🔒 Local by Design: Packs are built into the extension and are never updated or added remotely."
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