import { t } from "./t.js";

// Native locale metadata also guides pronunciation and logical layout.
const locale = t('@@ui_locale');
const direction = t('@@bidi_dir');
if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(locale)) {
  document.documentElement.lang = locale.replace(/_/g, '-');
}
if (direction === 'rtl' || direction === 'ltr') {
  document.documentElement.dir = direction;
}

const words = document.querySelectorAll("[data-i18n]");

for (let i = 0; i < words.length; i++) {
  const translation = t(words[i].getAttribute("data-i18n"));
  if (words[i].value === "i18n") {
    words[i].value = translation;
  } else {
    words[i].innerText = translation;
  }
}

const placeholders = document.querySelectorAll('[data-i18n-placeholder]');

for (let i = 0; i < placeholders.length; i++) {
  const key = placeholders[i].getAttribute('data-i18n-placeholder');
  const translation = t(key);
  if (translation) placeholders[i].placeholder = translation;
}

// Attribute-only translations preserve icons and nested controls.
for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
  const translation = t(element.getAttribute('data-i18n-aria-label'));
  if (translation) element.setAttribute('aria-label', translation);
}
