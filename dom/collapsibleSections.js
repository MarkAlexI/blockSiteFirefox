// Native buttons supply Enter/Space activation. Hidden panels keep their drafts
// in the DOM while removing their controls from Tab and the accessibility tree.
export function initializeCollapsibleSections(root = document) {
  for (const section of root.querySelectorAll('.collapsible-section')) {
    const button = section.querySelector('.collapsible-toggle');
    const panel = section.querySelector('.collapsible-content');
    if (!button || !panel) continue;

    const setExpanded = expanded => {
      button.setAttribute('aria-expanded', String(expanded));
      section.classList.toggle('expanded', expanded);
      panel.hidden = !expanded;
    };

    setExpanded(button.getAttribute('aria-expanded') === 'true');
    button.addEventListener('click', () => {
      setExpanded(button.getAttribute('aria-expanded') !== 'true');
    });
  }
}
