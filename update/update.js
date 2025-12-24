document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'A Pro mode has been developed to improve the experience with restrictions. Basic features remain available and free.',
    'Added basic statistics on the options page in Pro mode: number of rules, total sites blocked, and today’ s blocked count.',
    'In Pro mode, a context menu is now available that lets you block sites from links with a single click.',
    'Added password protection for rule deletion in Pro mode',
    'Improved the statistics system for Pro mode — it now tracks not only site blocks but also redirects. This helps make analytics more complete and accurate, so future improvements can be even smarter.',
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