document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "🗓️ Flexible Weekly Schedules: Use different blocking hours for weekdays, weekends, or any custom group of days.",
    "⏰ Multiple Time Groups: A single rule can now follow separate schedules across the week.",
    "⚡ Quick Presets: Start with Every day, Weekdays, or Weekends and adjust the times as needed.",
    "✅ Seamless Upgrade: Your existing scheduled rules continue to work automatically."
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