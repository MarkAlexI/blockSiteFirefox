document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    /*    'Added basic statistics on the options page: number of rules, total sites blocked, and today’ s blocked count.',
    'In Pro mode, a context menu is now available that lets you block sites from links with a single click.',
    'Added password protection for rule deletion in Pro mode',
    'Improved the statistics system — it now tracks not only site blocks but also redirects.',
    'This helps make analytics more complete and accurate, so future improvements can be even smarter.', */
    'This update improves how rule changes take effect. Now, whenever you add or edit a blocking rule on the settings page, any open tabs that match the rule’ s URL are closed immediately – no need to reload or wait.This makes rule management faster, cleaner, and more intuitive.',
    'This patch focuses on improving translation quality across the extension. Several localization issues have been corrected to ensure clearer, more accurate messaging for users in all supported languages.'
  ];
  
  const ul = document.getElementById('features');
  features.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.append(li);
  });
  
  document.getElementById('close-btn')
    .addEventListener('click', () => window.close());
});