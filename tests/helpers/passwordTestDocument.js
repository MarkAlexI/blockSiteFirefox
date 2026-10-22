import { FakeDocument } from './extensionTestHarness.js';

// Models dialog state/events only. Real focus isolation, keyboard delivery and
// accessible names are checked separately in the browser scenario.
export function createPasswordDocument() {
  const document = new FakeDocument();
  const opener = document.addElement('password-opener', 'button');
  document.addElement('add-rule', 'button');
  const modal = document.addElement('passwordModal', 'dialog');
  modal.className = 'modal hidden';
  for (const [id, tag] of [
    ['modalTitle', 'h3'], ['passwordInput1Label', 'label'], ['passwordInput1', 'input'],
    ['passwordInput2Label', 'label'], ['passwordInput2', 'input'], ['passwordError', 'p'],
    ['forgotPassword', 'button'], ['confirmPassword', 'button'], ['cancelPassword', 'button']
  ]) modal.appendChild(document.addElement(id, tag));
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'isConnected', { get() {
      let node = element;
      while (node.parentNode) node = node.parentNode;
      return node === document.documentElement;
    } });
    element.closest = selector => {
      for (let node = element; node; node = node.parentNode) {
        if (selector === '[hidden], .hidden, [inert]'
          ? node.hidden || node.inert || node.classList.contains('hidden')
          : node.matches(selector)) return node;
      }
      return null;
    };
    element.getClientRects = () => element.hidden || element.closest('.hidden') ? [] : [{}];
  }
  modal.open = false;
  modal.showModal = () => { modal.open = true; };
  modal.close = () => {
    modal.open = false;
    queueMicrotask(() => modal.dispatchEvent({ type: 'close' }));
  };
  opener.focus();
  return document;
}
