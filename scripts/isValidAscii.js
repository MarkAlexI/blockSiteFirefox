export function isValidAscii(input) {
  return /^[\x00-\x7F]*$/.test(input);
}