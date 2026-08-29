export function configureUrlInput(input) {
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'none');
  input.spellcheck = false;
  input.inputMode = 'url';
  return input;
}
