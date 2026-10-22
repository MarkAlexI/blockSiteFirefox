import { FakeDocument } from './extensionTestHarness.js';

// State/event model only; browser scenarios check native inertness and AX names.
export class DialogTestDocument extends FakeDocument {
  createElement(tagName) {
    const element = super.createElement(tagName);
    if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) element.tabIndex = 0;
    const document = this;
    Object.defineProperty(element, 'isConnected', { get() {
      let node = element;
      while (node.parentNode) node = node.parentNode;
      return node === document.documentElement;
    } });
    const matches = element.matches.bind(element);
    element.matches = selector => selector === ':disabled' ? element.disabled : matches(selector);
    element.closest = selector => {
      for (let node = element; node; node = node.parentNode) {
        if (selector === '[hidden], .hidden, [inert]'
          ? node.hidden || node.inert || node.classList.contains('hidden')
          : node.matches(selector)) return node;
      }
      return null;
    };
    element.getClientRects = () => element.closest('[hidden], .hidden, [inert]') ? [] : [{}];
    element.getBoundingClientRect = () => ({ left: 10, right: 110, top: 10, bottom: 110 });
    if (element.tagName === 'DIALOG') {
      element.open = false;
      element.closeCount = 0;
      element.showModal = () => { element.open = true; };
      element.close = () => {
        element.open = false;
        element.closeCount++;
        queueMicrotask(() => element.dispatchEvent({ type: 'close' }));
      };
    }
    return element;
  }
}
