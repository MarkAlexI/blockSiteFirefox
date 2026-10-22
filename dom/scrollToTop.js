export function scrollToTop(focusTarget = null) {
  const rootElement = document.documentElement;
  focusTarget?.focus({ preventScroll: true });
  
  rootElement.scrollTo({
    top: 0,
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  });
}

export function mountScroll(target, scrollToTopBtn, focusTarget = target) {
  const rootElement = window.document;
  
  function callback(entries, observer) {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        scrollToTopBtn.hidden = false;
        scrollToTopBtn.classList.add('showBtn');
      } else {
        if (document.activeElement === scrollToTopBtn) {
          focusTarget.focus({ preventScroll: true });
        }
        scrollToTopBtn.hidden = true;
        scrollToTopBtn.classList.remove('showBtn');
      }
    });
  }
  
  const options = {
    root: rootElement,
    rootMargin: '20px',
    threshold: 0,
  }
  
  let observer = new IntersectionObserver(callback, options);
  observer.observe(target);
}
