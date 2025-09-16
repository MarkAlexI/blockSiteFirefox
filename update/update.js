document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    /*    'Added basic statistics on the options page: number of rules, total sites blocked, and today’ s blocked count.',
    'In Pro mode, a context menu is now available that lets you block sites from links with a single click.',*/
    'Technical improvements and stability update: cleaner codebase, fewer bugs.',
    'On mobile devices, the "Block This Site" button now shows the domain of the open page for convenience.'
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