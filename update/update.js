document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'This update introduces Debug Mode for Pro users on the settings page, making it easier to diagnose issues and understand how the extension behaves.',
    'We’ve also improved internal loggingfor Pro users: logs are now clearer and more structured, with timestamps and visual context in the browser console. This helps with faster troubleshooting and more transparent behavior during advanced usage.',
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