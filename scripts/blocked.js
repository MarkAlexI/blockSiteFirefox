const closeBtn = document.getElementById('closeBtn');

closeBtn.addEventListener('click', () => {
  browser.runtime.sendMessage({
   type: 'close_current_tab'
  });
});