document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "🩺 Diagnostic Report: Generate a privacy-safe technical snapshot directly from the Options page.",
    "📋 Easy Support: Copy a readable report or export structured JSON without opening the browser console.",
    "🔒 Private by Design: Rules, URLs, license keys, emails, tokens, and passwords are not exposed.",
    "🧭 Mobile Friendly: Check DNR, permissions, Focus Session, and recent Debug Mode events on Firefox Android and desktop browsers."
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