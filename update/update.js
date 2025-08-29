document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'Added Strict mode — prevents accidental deletion of rules.',
    'New option to disable update notifications.',
/*    'Added basic statistics on the options page: number of rules, total sites blocked, and today’ s blocked count.',*/
    'Improved settings page with more control and convenience.',
    'Technical improvements and stability update: cleaner codebase, fewer bugs.',
    'Better synchronization of blocking rules',
    'Added support for a new language: Oriya (or).',
    'Security Mode is now visible in the popup for quick reference.',
    'Popup updates automatically when you change extension settings.'
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