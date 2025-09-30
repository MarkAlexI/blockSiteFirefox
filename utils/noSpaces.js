function removeSpaces(event) {
  event.target.value = event.target.value.replace(/\s/g, '');
}

export function initializeNoSpaceInputs() {
  const textInputs = document.querySelectorAll('input[type="text"]');
  textInputs.forEach(input => {
    input.addEventListener('input', removeSpaces);
  });
  
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE && node.matches('input[type="text"]')) {
          node.addEventListener('input', removeSpaces);
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          node.querySelectorAll('input[type="text"]').forEach(input => {
            input.addEventListener('input', removeSpaces);
          });
        }
      });
    });
  });
  
  observer.observe(document.getElementById('rules-container'), {
    childList: true,
    subtree: true
  });
}