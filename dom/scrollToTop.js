export function scrollToTop() {
  const rootElement = document.documentElement;
  
  rootElement.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}

export function mountScroll(target, scrollToTopBtn) {
  const rootElement = window.document;
  
  function callback(entries, observer) {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        scrollToTopBtn.classList.add('showBtn');
      } else {
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