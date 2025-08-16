document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'Added an options page for managing blocking rules in a full-screen interface.',
    'Implemented viewing, editing, adding, and deleting rules on the options page.',
    'Applied a consistent color scheme and localization support.',
    'Reused URL validation logic from the popup.',
    'Improved rule management by enabling editing without requiring deletion and re-creation.',
    'Updated manifest.json to include options_ui configuration.'
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