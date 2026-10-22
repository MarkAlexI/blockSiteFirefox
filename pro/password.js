const passwordModals = new WeakMap();

export class PasswordUtils {
  static async hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const hashBuffer = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
      key, 256
    );
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${salt}:${hash}`;
  }
  
  static async verifyPassword(input, storedHash) {
    if (!storedHash) return false;
    const [salt, hash] = storedHash.split(':');
    const newHash = await this.hashPassword(input, salt);
    return newHash === storedHash;
  }
  
  static showPasswordModal(type, callback, t) {
    const modal = document.getElementById('passwordModal');
    const previous = passwordModals.get(modal);
    const opener = previous?.opener || document.activeElement;
    // Only one prompt owns the shared dialog. Settle an older waiter before
    // replacing it; an in-flight recovery write must finish first.
    if (previous && !previous.cancel()) {
      if (type === 'verify') callback(false);
      return;
    }

    const title = document.getElementById('modalTitle');
    const label1 = document.getElementById('passwordInput1Label');
    const label2 = document.getElementById('passwordInput2Label');
    const input1 = document.getElementById('passwordInput1');
    const input2 = document.getElementById('passwordInput2');
    const error = document.getElementById('passwordError');
    const forgot = document.getElementById('forgotPassword');
    const confirmBtn = document.getElementById('confirmPassword');
    const cancelBtn = document.getElementById('cancelPassword');
    let mode = type;
    let closed = false;
    let busy = false;
    let recoveryWriteStarted = false;
    let shakeTimeout = null;
    const session = { opener, cancel: () => cancelModal() };
    const isCurrent = () => !closed && passwordModals.get(modal) === session;

    const canFocus = element => element?.isConnected && !element.disabled &&
      element.matches('button, input, select, textarea, a[href], [tabindex]') &&
      !element.closest('[hidden], .hidden, [inert]') && element.getClientRects().length > 0;
    const restoreFocus = () => {
      const target = [opener, document.getElementById('add-rule'),
        document.querySelector('[aria-controls="security-settings-panel"]'),
        document.getElementById('options-link')].find(canFocus);
      // Let the browser reveal a fallback action if the old opener disappeared.
      target?.focus();
    };
    const clearError = () => {
      error.textContent = '';
      input1.setAttribute('aria-invalid', 'false');
      input2.setAttribute('aria-invalid', 'false');
      clearTimeout(shakeTimeout);
      input1.classList.remove('shake');
    };
    const showError = (message, invalidInputs = []) => {
      error.textContent = message;
      for (const input of invalidInputs) input.setAttribute('aria-invalid', 'true');
    };
    const setBusy = value => {
      busy = value;
      confirmBtn.disabled = value;
      forgot.disabled = value;
      // Keep the focused input focusable during asynchronous work.
      input1.readOnly = input2.readOnly = value;
      modal.setAttribute('aria-busy', String(value));
    };
    const finish = (result, notify = true) => {
      if (!isCurrent()) return;
      closed = true;
      passwordModals.delete(modal);
      modal.onkeydown = modal.oncancel = modal.onclose = modal.oninput = null;
      confirmBtn.onclick = cancelBtn.onclick = forgot.onclick = null;
      clearError();
      input1.value = input2.value = '';
      input1.readOnly = input2.readOnly = false;
      confirmBtn.disabled = cancelBtn.disabled = forgot.disabled = false;
      modal.setAttribute('aria-busy', 'false');
      if (modal.open) modal.close();
      modal.classList.add('hidden');
      restoreFocus();
      // Close and release handlers before a callback can open another prompt.
      if (notify) return callback(result);
    };
    const cancelModal = () => {
      if (recoveryWriteStarted) return false;
      finish(false, type === 'verify');
      return true;
    };

    passwordModals.set(modal, session);
    input1.type = input2.type = 'password';
    input1.value = input2.value = '';
    input1.placeholder = label1.textContent = t('enterpassword');
    input2.placeholder = label2.textContent = t('confirmpassword');
    input1.autocomplete = type === 'set' ? 'new-password' : 'current-password';
    input2.autocomplete = 'new-password';
    label2.hidden = input2.hidden = type !== 'set';
    forgot.hidden = type === 'set';
    forgot.classList.toggle('hidden', forgot.hidden);
    title.textContent = type === 'set' ? t('setpassword') : t('enterpassword');
    confirmBtn.textContent = t('modalconfirm');
    cancelBtn.textContent = t('modalcancel');
    cancelBtn.disabled = false;
    clearError();
    error.classList.remove('hidden');
    setBusy(false);

    cancelBtn.onclick = cancelModal;
    modal.oncancel = event => {
      event.preventDefault();
      cancelModal();
    };
    modal.onclose = () => {
      // A queued close event from an earlier opening cannot cancel a new one.
      if (!modal.open) finish(false, type === 'verify');
    };
    modal.onkeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelModal();
      } else if (event.key === 'Enter' && !event.isComposing &&
          (event.target === input1 || event.target === input2)) {
        event.preventDefault();
        confirmBtn.click();
      } else if (event.key === 'Tab') {
        const controls = [input1, input2, confirmBtn, cancelBtn, forgot]
          .filter(element => !element.hidden && !element.disabled);
        const next = event.shiftKey ? controls.at(-1) : controls[0];
        const boundary = event.shiftKey ? controls[0] : controls.at(-1);
        if (document.activeElement === boundary) {
          event.preventDefault();
          next.focus();
        }
      }
    };
    modal.oninput = event => {
      if (event.target === input1 || event.target === input2) clearError();
    };

    confirmBtn.onclick = async () => {
      if (!isCurrent() || busy) return;
      clearError();
      setBusy(true);
      const val1 = input1.value.trim();
      try {
        if (mode === 'set') {
          if (val1 !== input2.value.trim()) {
            showError(t('passwordmismatch'), [input1, input2]);
            return;
          }
          if (val1.length < 6) {
            showError(t('passwordtooshort'), [input1]);
            return;
          }
          const hash = await this.hashPassword(val1);
          if (isCurrent()) finish(hash);
        } else if (mode === 'verify') {
          const settings = await browser.storage.sync.get(['settings']);
          if (!isCurrent()) return;
          const valid = await this.verifyPassword(val1, settings.settings?.passwordHash);
          if (!isCurrent()) return;
          if (valid) {
            finish(true);
          } else {
            showError(t('invalidpassword'), [input1]);
            input1.classList.add('shake');
            shakeTimeout = setTimeout(() => {
              if (isCurrent()) input1.classList.remove('shake');
            }, 500);
          }
        } else {
          if (!val1) {
            showError(t('subscriptionnotfound'), [input1]);
            return;
          }
          const storage = await browser.storage.sync.get(['credentials', 'settings']);
          if (!isCurrent()) return;
          if (!storage.credentials?.licenseKey || val1 !== storage.credentials.licenseKey) {
            showError(t('subscriptionnotfound'), [input1]);
            return;
          }
          // Once the durable reset begins, closing cannot undo it. Keep Cancel
          // disabled until settlement instead of reporting a cancelled write.
          recoveryWriteStarted = true;
          cancelBtn.disabled = true;
          await browser.storage.sync.set({ settings: {
            ...storage.settings, enablePassword: false, passwordHash: null
          } });
          if (!isCurrent()) return;
          recoveryWriteStarted = false;
          finish(false, type === 'verify');
          alert(t('passwordreset'));
          window.location.reload();
        }
      } catch {
        if (isCurrent()) showError(t(mode === 'verify' ? 'errorloadingsettings' : 'errorsavingsettings'));
      } finally {
        if (isCurrent()) {
          recoveryWriteStarted = false;
          cancelBtn.disabled = false;
          setBusy(false);
        }
      }
    };

    forgot.onclick = () => {
      if (!isCurrent() || busy) return;
      mode = 'recover';
      title.textContent = confirmBtn.textContent = t('restoreaccess');
      input1.value = '';
      input1.type = 'text';
      input1.autocomplete = 'off';
      input1.placeholder = label1.textContent = t('pastekeylabel');
      forgot.hidden = true;
      forgot.classList.add('hidden');
      clearError();
      input1.focus();
    };

    modal.classList.remove('hidden');
    try {
      modal.showModal();
      input1.focus();
    } catch {
      // Failure to open must not authorize a waiting protected action.
      finish(false, type === 'verify');
    }
  }
}
