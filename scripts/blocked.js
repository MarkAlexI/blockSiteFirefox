const closeBtn = document.getElementById('closeBtn');

closeBtn.addEventListener('click', () => {
  try {
    window.close();
  }
  catch (e) {
    browser.runtime.sendMessage({
      type: 'close_current_tab'
    });
  }
});