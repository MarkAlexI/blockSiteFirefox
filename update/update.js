document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const version = params.get('version') || '–';
  document.getElementById('version').textContent = version;
  
  const features = [
    'Introducing Category Blocking for Pro users - effortlessly pause or resume blocking for entire groups like Social Media, News, or Games with a single click.',
    'Rules now feature Hierarchical Management: they automatically become inactive and read-only when their parent category is unblocked, providing better visual clarity.',
    'Enjoy a redesigned, cleaner interface with smooth animations and collapsible settings sections, ensuring that advanced options stay out of your way until you need them.',
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