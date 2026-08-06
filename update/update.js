document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "🗓️ Schedule Rule Packs: Apply one shared schedule while adding a starter pack.",
    "⚙️ Advanced Timing: Use the same weekday, weekend, or custom time groups available for individual rules.",
    "✅ One-Step Setup: Selected rules are created with the schedule already attached.",
    "🛡️ Safely Validated: The service worker verifies the schedule before changing your rules."
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