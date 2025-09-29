document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    /*    'Added basic statistics on the options page: number of rules, total sites blocked, and today’ s blocked count.',
    'In Pro mode, a context menu is now available that lets you block sites from links with a single click.',
    'Added password protection for rule deletion in Pro mode',*/
    'Technical improvements and stability update: cleaner codebase, fewer bugs.',
    'On mobile devices, the "Block This Site" button now shows the domain of the open page for convenience.',
    'We’ve added categories to help you better organize your rules. Now you can group rules into: Social, News, Entertainment, Shopping, Work, Gaming, Adult or Uncategorized.',
    'During the update, all your existing rules were automatically migrated and assigned a category (by default: Uncategorized). You can edit them anytime to fit your workflow.',
    'This makes it easier to manage rules as your list grows.'
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