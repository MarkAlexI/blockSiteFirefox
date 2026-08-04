document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    "🛡️ More Reliable Rule Management: Changes from the popup, Settings page, and context menu are now coordinated to prevent rules from being overwritten.",
    "⚡ Consistent Updates: Adding, editing, pausing, or deleting a rule now keeps your saved list and active blocking state aligned.",
    "🔎 Safer Editing: Rules keep a stable identity, so searching or filtering the list cannot cause the wrong rule to be changed.",
    "📦 Safer Imports and Cleanup: Backup files are checked before replacing your rules, and clearing the list now removes active blocking rules more reliably."
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