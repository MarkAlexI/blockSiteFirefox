document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'Introducing Focus Session, a new powerful tool for maximum concentration when you need it most.',
    'Added "Hardcore Mode" for Pro users, which hides the "Stop" button during a session.',
    'During an active Focus Session, the rule management UI is now locked to prevent impulsive changes.',
    'Added a visual banner to the settings page that displays the active focus session and remaining time.',
    "We're happy to announce that our extension is now also available in the Microsoft Edge Add-ons Store!"
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