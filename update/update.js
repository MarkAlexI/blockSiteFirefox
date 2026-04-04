document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'Introducing intelligent rule pausing—disable any website block with a single click, then reactivate whenever you need to refocus. Keep your rules intact, take control whenever you need flexibility.',
    'When you create a schedule for a blocked website, the rule automatically becomes active so your timetable works immediately. Perfect for scheduling focus sessions without friction.',
    'Free users can now create up to 10 rules instead of 5—more flexibility for everyone to stay productive without distractions.',
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